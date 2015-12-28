/** @module transition */ /** for typedoc */
import {IPromise} from "angular";
import {TransitionHookOptions} from "./interface";
import {IInjectable, defaults, extend, noop, filter, not, isFunction, isDefined, map, pattern, val,
    eq, is, isPromise, isObject, parse, fnToString, maxLength, Predicate} from "../common/common";
import {runtime, trace} from "../common/module";

import {Transition} from "./transition";
import {TransitionRejection, RejectFactory} from "./rejectFactory";
import {State} from "../state/module";
import {Resolvable, ResolveContext} from "../resolve/module";

let REJECT = new RejectFactory();

let defaultOptions = {
  async: true,
  rejectIfSuperseded: true,
  current: noop,
  transition: null,
  traceData: {}
};

export class TransitionHook {
  constructor(private fn:IInjectable,
              private locals: any,
              private resolveContext: ResolveContext,
              private options: TransitionHookOptions) {
    this.options = defaults(options, defaultOptions);
  }

  private isSuperseded = () => this.options.current() !== this.options.transition;

  /**
   * Handles transition abort and transition redirect. Also adds any returned resolvables
   * to the pathContext for the current pathElement.  If the transition is rejected, then a rejected
   * promise is returned here, otherwise undefined is returned.
   */
  mapHookResult: Function = pattern([
    // Transition is no longer current
    [this.isSuperseded, () => REJECT.superseded(this.options.current())],
    // If the hook returns false, abort the current Transition
    [eq(false),         val(REJECT.aborted("Hook aborted transition"))],
    // If the hook returns a Transition, halt the current Transition and redirect to that Transition.
    [is(Transition),    (transition) => REJECT.redirected(transition)],
    // A promise was returned, wait for the promise and then chain another hookHandler
    [isPromise,         (promise) => promise.then(this.handleHookResult.bind(this))]
  ]);

  invokeStep = (moreLocals) => { // bind to this
    let { options, fn, resolveContext } = this;
    let locals = extend({}, this.locals, moreLocals);
    trace.traceHookInvocation(this, options);
    if (options.rejectIfSuperseded && this.isSuperseded()) {
      return REJECT.superseded(options.current());
    }

    // TODO: Need better integration of returned promises in synchronous code.
    if (!options.async) {
      let hookResult = resolveContext.invokeNow(fn, locals, options);
      return this.handleHookResult(hookResult);
    }
    return resolveContext.invokeLater(fn, locals, options).then(this.handleHookResult.bind(this));
  };

  handleHookResult(hookResult) {
    if (!isDefined(hookResult)) return undefined;
    trace.traceHookResult(hookResult, undefined, this.options);

    let transitionResult = this.mapHookResult(hookResult);
    if (transitionResult) trace.traceHookResult(hookResult, transitionResult, this.options);

    return transitionResult;
  }

  toString() {
    let { options, fn } = this;
    let event = parse("traceData.hookType")(options) || "internal",
        context = parse("traceData.context.state.name")(options) || parse("traceData.context")(options) || "unknown",
        name = fnToString(fn);
    return `${event} context: ${context}, ${maxLength(200, name)}`;
  }


  /**
   * Given an array of TransitionHooks, runs each one synchronously and sequentially.
   *
   * Returns a promise chain composed of any promises returned from each hook.invokeStep() call
   */
  static runSynchronousHooks(hooks: TransitionHook[], locals = {}, swallowExceptions: boolean = false): IPromise<any> {
    let results = [];
    for (let i = 0; i < hooks.length; i++) {
      try {
        results.push(hooks[i].invokeStep(locals));
      } catch (exception) {
        if (!swallowExceptions) throw exception;
        console.log("Swallowed exception during synchronous hook handler: " + exception); // TODO: What to do here?
      }
    }

    let rejections = results.filter(TransitionHook.isRejection);
    if (rejections.length) return rejections[0];

    return results
        .filter(not(TransitionHook.isRejection))
        .filter(<Predicate<any>> isPromise)
        .reduce((chain, promise) => chain.then(val(promise)), runtime.$q.when());
  }


  static isRejection(hookResult) {
    return hookResult && hookResult.reason instanceof TransitionRejection && hookResult;
  }
}
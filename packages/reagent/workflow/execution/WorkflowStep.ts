import {
  all,
  put,
  call,
  take,
  getContext,
  fork,
  cancel,
  join,
  cancelled,
} from "redux-saga/effects";

import { Context } from "../core/context.js";
import { AbstractWorkflowNode } from "../core/node.js";
import { InternalWorkflowRef } from "./Workflow.js";
import {
  AbstractValueProvider,
  InternalValueProvider,
  OutputValueProvider,
  RenderOutputProvider,
  ToolProvider,
  ValueProvider,
} from "./WorkflowStepOutput.js";
import { Lazy, lazy } from "./operators/index.js";
import { EventType, type EdgeBindings, type RenderUpdate } from "./types.js";

const TOOL_CALL_SAGA = Symbol("TOOL_CALL_SAGA");

type WorkflowStepOptions = {
  label?: string;
};

type EdgeBindingWithToolCall<Input> = EdgeBindings<Input> & {
  [TOOL_CALL_SAGA]?: any;
};

class WorkflowStepRef<
  Config extends Record<string, unknown> | void,
  Input extends Record<string, unknown>,
  Output extends Record<string, unknown>,
> {
  nodeId: string;
  node: AbstractWorkflowNode<Config, Input, Output>;
  config: Config;
  options: WorkflowStepOptions;
  step: WorkflowStep<Config, Input, Output>;
  bindings?: EdgeBindingWithToolCall<Input>;
  subscriptions: Set<any>;
  constructor(
    nodeId: string,
    node: AbstractWorkflowNode<Config, Input, Output>,
    config: Config,
    options: WorkflowStepOptions,
    step: WorkflowStep<Config, Input, Output>
  ) {
    this.nodeId = nodeId;
    this.node = node;
    this.config = config;
    this.options = options;
    this.step = step;
    this.subscriptions = new Set();
  }

  setBindings(bindings: EdgeBindingWithToolCall<Input>) {
    this.bindings = bindings;
  }

  get dependencies() {
    return Object.values(this.bindings || {}).flatMap((provider) => {
      return (provider as InternalValueProvider<any>).dependencies || [];
    });
  }

  async execute(options: { session: any; input: any; dispatch: any }) {
    const self = this;
    const context = self.#buildContext(options.session, options.dispatch);
    const generator = self.node.execute(context, options.input);
    const output = {};
    for await (const partialOutput of generator) {
      context.sendOutput(partialOutput);
      Object.assign(output, partialOutput);
    }

    options.dispatch({
      type: EventType.RUN_COMPLETED,
      session: options.session,
      node: { id: self.nodeId },
    });
    return output as Output;
  }

  *saga(): any {
    const self = this;
    const subs = [...self.subscriptions].map((sub) => sub());
    yield fork(function* saga(): any {
      if (subs.length == 0) {
        return;
      }
      yield all(subs);
    });

    yield fork(function* saga(): any {
      const bindings = yield fork(self.bindingsResolver.bind(self));
      const invoke = yield fork(self.invokeListenerSaga.bind(self));

      try {
        yield join([invoke, bindings]);
      } finally {
        yield cancel();
      }
    });
  }

  *invokeListenerSaga(): any {
    const self = this;
    const action = yield take(
      (e: any) =>
        (e.type == EventType.NO_BINDINGS ||
          e.type == EventType.INVOKE ||
          e.type == EventType.SKIP_INVOKE ||
          e.type == EventType.EXECUTE_ON_CLIENT) &&
        e.node.id == self.nodeId
    );
    if (action.type != EventType.INVOKE) {
      return;
    }

    const dispatch = yield getContext("dispatch");
    const session = yield getContext("session");
    if (self.node.metadata.target == "client") {
      yield dispatch({
        type: EventType.EXECUTE_ON_CLIENT,
        session,
        node: {
          id: self.nodeId,
          type: self.node.metadata.id,
          version: self.node.metadata.version,
        },
        input: action.input,
      });
      yield cancel();
    } else {
      yield call(self.execute.bind(self), {
        input: action.input,
        dispatch,
        session,
      });
    }
  }

  *bindingsResolver(): any {
    const self = this;
    if (!self.bindings) {
      yield take(EventType.START);
      // TODO: handle nodes that have no input. do those nodes need
      // to be bound? if not, when to invoke them?
      return;
    }
    const toolCallInputSaga = self.bindings![TOOL_CALL_SAGA]
      ? yield fork(self.bindings![TOOL_CALL_SAGA])
      : undefined;
    const cleanups: any[] = [];
    try {
      const session = yield getContext("session");
      const dispatch = yield getContext("dispatch");
      const context = self.#buildContext(session, dispatch);

      function createValueResolver(v: any) {
        return function* resolveValueProvider(): any {
          if (AbstractValueProvider.isValueProvider(v)) {
            const res = yield v.saga();
            // res is undefined if the saga was cancell
            if (res.onSkipped) {
              cleanups.push(res.onSkipped);
            }
            return res.value;
          } else {
            if (lazy.isLazy(v)) {
              if (toolCallInputSaga) {
                yield take(
                  (e: any) =>
                    e.type == EventType.TOOL_CALL && e.node.id == self.nodeId
                );
              }
              return (v as unknown as Lazy<any>)();
            }
            return v;
          }
        };
      }

      const sagas = Object.fromEntries(
        Object.entries(self.bindings!).map(([key, value]) => {
          return [
            key,
            (function* saga(): any {
              let output;
              if (Array.isArray(value)) {
                output = yield all(
                  value.map((v: InternalValueProvider<any>) => {
                    return createValueResolver(v)();
                  })
                );
              } else {
                output = yield createValueResolver(value)();
              }
              self.node.onInputEvent(context, {
                [key]: output,
              } as any);
              return output;
            })(),
          ];
        })
      );

      const input = yield all(sagas);
      if (toolCallInputSaga) {
        const toolCallInput = yield join(toolCallInputSaga!);
        Object.assign(input, toolCallInput);
      }

      yield put({
        type: EventType.INVOKE,
        node: {
          id: self.nodeId,
        },
        input,
      });
      // if the node was invoked, wait for the run to complete
      // before cleaning up
      yield fork(function* saga() {
        yield take((e: any) => {
          return (
            (e.type == EventType.RUN_COMPLETED ||
              e.type == EventType.EXECUTE_ON_CLIENT) &&
            e.node.id == self.nodeId
          );
        });
        cleanups.forEach((cleanup) => cleanup());
      });
      return input;
    } finally {
      if (yield cancelled()) {
        yield put({
          type: EventType.RUN_CANCELLED,
          node: {
            id: self.nodeId,
          },
        });
        cleanups.forEach((cleanup) => cleanup());
      }
    }
  }

  #buildContext(
    session: Context<any, any>["session"],
    dispatch: any
  ): Context<any, any> {
    const self = this;
    const node = {
      id: self.nodeId,
    };
    return {
      session,
      node,
      config: this.config || {},
      sendOutput(output: Output) {
        dispatch({
          type: EventType.OUTPUT,
          session,
          node,
          output,
        });
      },
      render(step, data) {
        // since this runs in server side,
        // render will be transpiled to only pass component id
        const stepId = step as unknown as string;
        const node = {
          id: self.nodeId,
          type: self.node.metadata.id,
          version: self.node.metadata.version,
        };
        dispatch({
          type: EventType.RENDER,
          session,
          node,
          render: {
            step: stepId,
            data,
          },
        });
        return {
          update(data) {
            dispatch({
              type: EventType.RENDER,
              session,
              node,
              render: {
                step: stepId,
                data,
              },
            });
          },
        };
      },
    };
  }
}

class WorkflowStep<
  Config extends Record<string, unknown> | void,
  Input extends Record<string, unknown>,
  Output extends Record<string, unknown>,
> {
  #ref: WorkflowStepRef<Config, Input, Output>;
  #workflow: InternalWorkflowRef;
  // This is "phantom" field only used for type inference
  _types: { output: Output };

  constructor(
    workflow: InternalWorkflowRef,
    nodeId: string,
    node: AbstractWorkflowNode<Config, Input, Output>,
    config: Config,
    options: WorkflowStepOptions
  ) {
    this.#ref = new WorkflowStepRef(nodeId, node, config, options, this);
    this.#workflow = workflow;
    this.#workflow.addNodeRef(this.#ref);
    // @ts-expect-error
    this._types = undefined;
  }

  get id() {
    return this.#ref.nodeId;
  }

  bind(bindings: EdgeBindingWithToolCall<Input>) {
    this.#ref.setBindings(bindings);
    this.#workflow.calculateNodeDependencies(this.#ref.nodeId);
  }

  asTool<Params extends (keyof Input)[]>(options: {
    bind?: EdgeBindings<Omit<Input, Params[number]>>;
    parameters: Params;
    output?: (keyof Output)[];
  }) {
    const self = this;
    const provider = new ToolProvider<any>(this.#ref, {
      parameters: options.parameters as any,
      output: options.output as any,
    });
    const bindings = options.bind as any;
    bindings[TOOL_CALL_SAGA] = function* saga(): any {
      const action = yield take(
        (e: any) =>
          (e.type == EventType.TOOL_CALL || e.type == EventType.SKIP_RUN) &&
          e.node.id == self.#ref.nodeId
      );
      if (action.type == EventType.SKIP_RUN) {
        yield cancel();
      }
      return action.input;
    };
    this.#ref.setBindings(bindings);
    this.#workflow.calculateNodeDependencies(this.#ref.nodeId);
    return provider;
  }

  get output(): {
    [K in keyof Output]: ValueProvider<Output[K]>;
  } {
    const self = this;
    // @ts-expect-error
    return new Proxy(
      {},
      {
        get(_, field: string) {
          return new OutputValueProvider(self.#ref, field);
        },
      }
    );
  }

  get renderOutput(): ValueProvider<RenderUpdate> {
    return new RenderOutputProvider(this.#ref);
  }
}

export { WorkflowStep, WorkflowStepRef };
export type { WorkflowStepOptions };

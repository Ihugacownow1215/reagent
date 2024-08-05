import {
  Observable,
  ReplaySubject,
  map,
  mergeMap,
} from "@reagentai/reagent/rxjs";
import { Workflow, Task, WorkflowRunOptions } from "@reagentai/reagent";
import { uniqueId } from "@reagentai/reagent/utils";
import type { Chat } from "@reagentai/reagent/chat";

type OutputStream = Observable<any> & {
  task: Task;
  toResponse(): Response;
};

const triggerReagentWorkflow = (
  workflow: Workflow,
  options: WorkflowRunOptions
) => {
  const workflowOutputStream = new ReplaySubject<Chat.Response>();
  const run = workflow.emit(options);
  run.task.toPromise().finally(() => {
    workflowOutputStream.complete();
  });
  run.output.ui.subscribe({
    next(output: any) {
      const { node, value } = output;
      const createdAt = new Date();
      workflowOutputStream.next({
        type: "message/ui/update" as const,
        data: {
          id: run.id + "-" + node.id,
          node,
          ui: value,
          role: "ai",
          createdAt: createdAt.toISOString(),
        },
      });
    },
    error(err: any) {
      console.error(err);
    },
  });

  run.output.markdownStream
    .pipe(
      mergeMap((stream) => {
        let messageId = uniqueId();
        const createdAt = new Date();
        return stream.value.pipe(
          map((data) => {
            return {
              type: "message/content/delta" as const,
              data: {
                id: messageId,
                node: stream.node,
                message: {
                  content: data.delta,
                },
                role: "ai",
                createdAt: createdAt.toISOString(),
              },
            };
          })
        );
      })
    )
    .subscribe({
      next(data: any) {
        workflowOutputStream.next(data);
      },
    });

  run.output.markdown
    .pipe(
      map(({ node, value }) => {
        let messageId = uniqueId();
        const createdAt = new Date();
        return {
          type: "message/content" as const,
          data: {
            id: messageId,
            node,
            message: {
              content: value,
            },
            role: "ai",
            createdAt: createdAt.toISOString(),
          },
        };
      })
    )
    .subscribe({
      next(data: any) {
        workflowOutputStream.next(data);
      },
    });

  run.events.subscribe({
    next(data) {
      workflowOutputStream.next({
        type: "event",
        data,
      });
    },
  });

  return Object.assign(workflowOutputStream, {
    task: run.task,
    toResponse() {
      const self = this;
      const responseStream = new ReadableStream({
        async start(controller) {
          self.subscribe({
            next(data) {
              try {
                controller.enqueue("data: " + JSON.stringify(data) + "\n\n");
              } catch (e) {
                console.error("Error sending message to stream:", e);
              }
            },
            complete() {
              try {
                controller.close();
              } catch (e) {
                console.error("Error closing stream:", e);
              }
            },
          });
        },
      });

      return new Response(responseStream, {
        status: 200,
        headers: [["Content-Type", "text/event-stream"]],
      });
    },
  } as OutputStream);
};

export { triggerReagentWorkflow };

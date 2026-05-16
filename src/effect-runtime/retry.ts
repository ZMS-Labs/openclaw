import { Effect, Schedule, ScheduleDecision, ScheduleInterval } from "effect";

import { promiseEffect, runOpenClawEffect, type OpenClawEffect } from "./index.js";

export type RetryingPromiseParams<T> = {
  operation: () => Promise<T>;
  maxAttempts: number;
  shouldRetry: (error: unknown, attemptNumber: number) => boolean;
  resolveDelayMs: (attemptNumber: number) => number;
  sleep: (delayMs: number) => Promise<void>;
};

function retryDecisionSchedule(
  params: Pick<RetryingPromiseParams<unknown>, "maxAttempts" | "shouldRetry">,
): Schedule.Schedule<number, unknown> {
  return Schedule.makeWithState(1, (now, error, attemptNumber) => {
    const shouldRetry =
      attemptNumber < params.maxAttempts && params.shouldRetry(error, attemptNumber);
    return Effect.succeed([
      attemptNumber + 1,
      attemptNumber,
      shouldRetry
        ? ScheduleDecision.continueWith(ScheduleInterval.after(now))
        : ScheduleDecision.done,
    ] as const);
  });
}

function runAttempt<T>(
  params: RetryingPromiseParams<T>,
  retryDriver: Schedule.ScheduleDriver<number, unknown>,
): OpenClawEffect<T, unknown> {
  return Effect.suspend(() =>
    promiseEffect({
      try: () => params.operation(),
    }).pipe(
      Effect.catchAll((error) => {
        return retryDriver.next(error).pipe(
          Effect.catchAll(() => Effect.fail(error)),
          Effect.flatMap((attemptNumber) =>
            promiseEffect({
              try: () => params.sleep(params.resolveDelayMs(attemptNumber)),
            }).pipe(Effect.flatMap(() => runAttempt(params, retryDriver))),
          ),
        );
      }),
    ),
  );
}

export async function runRetryingPromise<T>(params: RetryingPromiseParams<T>): Promise<T> {
  return await runOpenClawEffect(
    Schedule.driver(retryDecisionSchedule(params)).pipe(
      Effect.flatMap((retryDriver) => runAttempt(params, retryDriver)),
    ),
  );
}

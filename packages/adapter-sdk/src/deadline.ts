// SPDX-License-Identifier: Apache-2.0

export interface AdapterDeadline {
  /** JavaScript epoch milliseconds, matching Date.now(). */
  readonly at: number;
}

export type DeadlineInput = AdapterDeadline | Date | number | string;

export class AdapterDeadlineError extends Error {
  readonly code = "deadline_exceeded";

  constructor(message = "The adapter command deadline was exceeded.") {
    super(message);
    this.name = "AdapterDeadlineError";
  }
}

function dateValue(input: Date | number | string): number {
  if (input instanceof Date) {
    return input.getTime();
  }
  return typeof input === "string" ? Date.parse(input) : input;
}

export function deadlineAt(input: Date | number | string): AdapterDeadline {
  const at = dateValue(input);
  if (!Number.isFinite(at) || at < 0) {
    throw new RangeError("A deadline must be a valid epoch-millisecond value.");
  }
  return Object.freeze({ at });
}

export function deadlineAfter(
  timeoutMilliseconds: number,
  now: number | (() => number) = Date.now,
): AdapterDeadline {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    throw new RangeError("A deadline timeout must be a non-negative number.");
  }
  const current = typeof now === "function" ? now() : now;
  return deadlineAt(current + timeoutMilliseconds);
}

export function normalizeDeadline(input: DeadlineInput): AdapterDeadline {
  return typeof input === "object" && !(input instanceof Date) && "at" in input
    ? deadlineAt(input.at)
    : deadlineAt(input as Date | number | string);
}

export function remainingDeadlineMilliseconds(
  input: DeadlineInput,
  now: number | (() => number) = Date.now,
): number {
  const current = typeof now === "function" ? now() : now;
  return Math.max(0, normalizeDeadline(input).at - current);
}

export function isDeadlineExceeded(
  input: DeadlineInput,
  now: number | (() => number) = Date.now,
): boolean {
  const current = typeof now === "function" ? now() : now;
  return normalizeDeadline(input).at <= current;
}

export function throwIfDeadlineExceeded(
  input: DeadlineInput,
  now: number | (() => number) = Date.now,
): void {
  if (isDeadlineExceeded(input, now)) {
    throw new AdapterDeadlineError();
  }
}

export interface DeadlineSignal {
  readonly deadline: AdapterDeadline;
  readonly signal: AbortSignal;
  dispose(): void;
  didTimeout(): boolean;
}

export function createDeadlineSignal(
  input: DeadlineInput,
  parentSignal?: AbortSignal,
  now: () => number = Date.now,
): DeadlineSignal {
  const deadline = normalizeDeadline(input);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted === true) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const schedule = (): void => {
    if (controller.signal.aborted) {
      return;
    }
    const remaining = deadline.at - now();
    if (remaining <= 0) {
      timedOut = true;
      controller.abort(new AdapterDeadlineError());
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  };
  schedule();

  const dispose = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal?.removeEventListener("abort", abortFromParent);
  };

  controller.signal.addEventListener("abort", dispose, { once: true });
  return Object.freeze({
    deadline,
    signal: controller.signal,
    dispose,
    didTimeout: () => timedOut,
  });
}

export async function withDeadline<T>(
  input: DeadlineInput,
  task: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const deadlineSignal = createDeadlineSignal(input, parentSignal);
  try {
    if (deadlineSignal.signal.aborted) {
      throw deadlineSignal.signal.reason instanceof Error
        ? deadlineSignal.signal.reason
        : new AdapterDeadlineError();
    }
    return await Promise.race([
      task(deadlineSignal.signal),
      new Promise<never>((_resolve, reject) => {
        const rejectOnAbort = (): void => {
          reject(
            deadlineSignal.signal.reason instanceof Error
              ? deadlineSignal.signal.reason
              : new AdapterDeadlineError(),
          );
        };
        if (deadlineSignal.signal.aborted) {
          rejectOnAbort();
          return;
        }
        deadlineSignal.signal.addEventListener("abort", rejectOnAbort, {
          once: true,
        });
      }),
    ]);
  } finally {
    deadlineSignal.dispose();
  }
}

export function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof AdapterDeadlineError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.message.toLowerCase().includes("deadline")))
  );
}

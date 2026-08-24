export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    timeoutId = setTimeout(() => {
      timeoutId = null;
      reject(createError());
      onTimeout?.();
    }, timeoutMs);

    promise.then(
      (value) => {
        clear();
        resolve(value);
      },
      (error) => {
        clear();
        reject(error);
      },
    );
  });
}

export function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  const controller = new AbortController();
  return withTimeout(run(controller.signal), timeoutMs, createError, () => {
    controller.abort();
  });
}

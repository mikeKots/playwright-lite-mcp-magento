/**
 * Runs async jobs strictly one after another.
 * Agents sometimes fire several tool calls in parallel; two clicks racing on the
 * same page produce flaky, confusing results, so every tool call is serialized.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

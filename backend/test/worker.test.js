import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
const { PythonWorker } = createRequire(import.meta.url)(
  "../services/worker.cjs",
);

function fakeProcess(respond) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString());
      queueMicrotask(() => respond(request, child));
      done();
    },
  });
  return child;
}
test("one persistent worker serializes concurrent jobs with correctly matched replies", async (t) => {
  let spawns = 0;
  const worker = new PythonWorker({
    spawnProcess: (_exe, args, options) => {
      spawns++;
      assert.deepEqual(args, ["-m", "ml.worker"]);
      assert.match(options.cwd, /backend$/);
      return fakeProcess(({ id, csv }, child) =>
        child.stdout.write(JSON.stringify({ id, result: { csv } }) + "\n"),
      );
    },
  });
  t.after(() => worker.close());
  const result = await Promise.all([
    worker.analyze("one"),
    worker.analyze("two"),
  ]);
  assert.deepEqual(result, [{ csv: "one" }, { csv: "two" }]);
  assert.equal(spawns, 1);
});
test("queue is bounded and a timed out process is killed then respawned", async (t) => {
  const children = [];
  const worker = new PythonWorker({
    timeoutMs: 30,
    maxQueue: 1,
    spawnProcess: () => {
      const child = fakeProcess(({ id }, process) => {
        if (children.length > 1)
          process.stdout.write(
            JSON.stringify({ id, result: { ok: true } }) + "\n",
          );
      });
      children.push(child);
      return child;
    },
  });
  t.after(() => worker.close());
  const first = assert.rejects(
    worker.analyze("one"),
    (error) => error.status === 504,
  );
  const queued = assert.rejects(
    worker.analyze("two"),
    (error) => error.status === 504,
  );
  await assert.rejects(worker.analyze("three"), /capacity/);
  await Promise.all([first, queued]);
  assert.equal(children[0].killed, true);
  assert.deepEqual(await worker.analyze("retry"), { ok: true });
  assert.equal(children.length, 2);
});
test("bad JSON or mismatched IDs fail closed without leaking subprocess output", async (t) => {
  for (const output of ["SECRET", '{"id":"wrong","result":{}}']) {
    const worker = new PythonWorker({
      spawnProcess: () =>
        fakeProcess((_job, child) => child.stdout.write(output + "\n")),
    });
    t.after(() => worker.close());
    await assert.rejects(
      worker.analyze("sensitive"),
      (error) => error.status === 503 && !error.message.includes("SECRET"),
    );
  }
});
test("validation errors preserve data quality and keep worker alive", async (t) => {
  let spawns = 0;
  const worker = new PythonWorker({
    spawnProcess: () => {
      spawns++;
      return fakeProcess(({ id }, child) =>
        child.stdout.write(
          JSON.stringify({
            id,
            error: { message: "Invalid CSV.", quality: { malformed_rows: 1 } },
          }) + "\n",
        ),
      );
    },
  });
  t.after(() => worker.close());
  await assert.rejects(
    worker.analyze("bad"),
    (error) => error.status === 422 && error.quality.malformed_rows === 1,
  );
  await assert.rejects(worker.analyze("bad-again"), /Invalid CSV/);
  assert.equal(spawns, 1);
});

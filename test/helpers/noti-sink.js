"use strict";
// 구독의 nu가 가리킬 로컬 통지 수신기.
//
// "도착할 때까지 대기"(waitFor)와 "도착하지 않음을 확인"(expectNone)은 성격이 다르다.
// 전자는 조건 충족 즉시 끝내야 빠르고, 후자는 고정 유예를 반드시 기다려야 정확하다.
// 이 구분을 헬퍼에서 강제해 테스트가 무통지를 짧은 타임아웃으로 오판하지 않게 한다.

const http = require("node:http");

function netOf(item) {
  return (item && item.body && item.body["m2m:sgn"] && item.body["m2m:sgn"].nev)
    ? item.body["m2m:sgn"].nev.net
    : null;
}

async function startSink() {
  const received = [];
  const waiters = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      const item = { url: req.url, body: parsed, raw };
      received.push(item);

      for (const w of waiters.slice()) {
        let matched = false;
        try { matched = w.pred(item); } catch { matched = false; }
        if (matched) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(item);
        }
      }
      // CSE가 통지 전송을 성공으로 판정하도록 oneM2M 응답 코드를 돌려준다.
      res.writeHead(200, { "X-M2M-RSC": "2000", "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/noti`;

  function waitFor(pred, { timeoutMs = 5000 } = {}) {
    const already = received.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(
          `통지 대기 타임아웃(${timeoutMs}ms). 수신 ${received.length}건, net=` +
          JSON.stringify(received.map(netOf))
        ));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  async function expectNone(pred, { graceMs = 2000 } = {}) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    return received.filter(pred);
  }

  return {
    url, received, waitFor, expectNone, netOf,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startSink, netOf };

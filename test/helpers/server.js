"use strict";
// mobius4를 테스트 전용 설정으로 자식 프로세스로 띄운다.
//
// 설정을 config/test.json이 아니라 NODE_CONFIG 환경변수로 주입하는 이유(DEC-037):
// node-config의 병합 순서에서 local.json(9순위)이 {deployment}.json(3순위)을 덮어쓴다.
// 실측 결과 config/test.json으로는 포트가 7599, mqtt가 true로 남아 테스트가 개발
// 인스턴스를 두드린다. config/local-test.json은 .gitignore로 커밋할 수 없다.

const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TEST_DB = "mobius4_test";
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

// OS가 비어 있는 포트를 골라준다 — 고정 포트로 두면 개발 인스턴스나 병행 실행과 겹친다.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 진단 버퍼 상한 — 수다스러운 서버라도 무한정 자라지 않게 마지막 ~64KB만 남긴다.
const DIAG_BUFFER_MAX = 64 * 1024;

async function startServer() {
  const port = await freePort();
  // bindings/http.js는 https 리스너에 enabled 플래그가 없이 config.https.port(기본 7580)로
  // 무조건 listen한다. 개발 인스턴스가 그 포트를 이미 물고 있으므로 여기서도 별도의
  // 빈 포트를 골라 겹치지 않게 한다(HTTPS 자체는 이 테스트들이 검증 대상으로 삼지 않는다).
  const httpsPort = await freePort();
  const overrides = {
    http: { port },
    https: { port: httpsPort },
    db: { name: TEST_DB },
    mqtt: { enabled: false },
    // default.json이 logs/mobius4.log 파일 로깅을 켜므로 명시적으로 끈다.
    // console은 남겨 둔다 — logger.js는 stdout에만 쓰고 stderr에는 아무것도 쓰지 않으므로
    // 기동 실패 시 단서는 stdout(예: fatal 로그)에 있다. 그래서 stdout·stderr를 모두 모은다.
    logging: { level: "error", file: { enabled: false } },
  };

  const child = spawn(process.execPath, ["mobius4.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "test", NODE_CONFIG: JSON.stringify(overrides) },
    // ipc: mobius4.js가 main() 완료 후 process.send('ready')를 보낸다(PM2 wait_ready 연동).
    // 덕분에 HTTP 폴링 없이 결정론적으로 기동 완료를 알 수 있다.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let diag = "";
  function appendDiag(chunk) {
    diag += chunk.toString();
    if (diag.length > DIAG_BUFFER_MAX) diag = diag.slice(diag.length - DIAG_BUFFER_MAX);
  }
  // 두 파이프 모두 반드시 소비한다 — 읽지 않은 파이프는 버퍼가 차서 자식 프로세스를 멈춰 세운다.
  child.stdout.on("data", appendDiag);
  child.stderr.on("data", appendDiag);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`서버 기동 타임아웃(${START_TIMEOUT_MS}ms). 출력:\n${diag}`));
    }, START_TIMEOUT_MS);

    const onMessage = (m) => { if (m === "ready") { cleanup(); resolve(); } };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`서버가 기동 중 종료됨(code=${code}). 출력:\n${diag}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return { child, port, httpsPort, baseUrl, diagnostics: () => diag, stop: () => stopServer(child) };
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(force); resolve(); });
    child.kill("SIGTERM");
  });
}

module.exports = { startServer, stopServer, TEST_DB };

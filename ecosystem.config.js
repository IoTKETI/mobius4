module.exports = {
    apps: [{
        name: 'mobius4',
        script: 'mobius4.js',
        instances: 1,       // MQTT·DB 전역 상태로 인해 cluster 모드 불가
        exec_mode: 'fork',

        // PM2가 process.send('ready') 신호를 기다림
        wait_ready: true,
        listen_timeout: 15000,  // ready 신호 대기 상한 (DB+MQTT 초기화 시간 고려)

        // 앱 내부 30초 shutdown timeout보다 여유 있게 설정
        kill_timeout: 35000,

        // 재시작 정책
        autorestart: true,
        max_restarts: 10,
        min_uptime: 5000,   // 5초 이상 유지돼야 정상 기동으로 간주
        restart_delay: 1000,

        // Pino가 logs/ 에서 파일 로깅+로테이션을 담당하므로 PM2 로그 파일 비활성화
        out_file: '/dev/null',
        error_file: '/dev/null',

        // 환경별 설정 — 민감 정보는 config/local.json 에서 관리
        env: {
            NODE_ENV: 'dev'
        },
        env_production: {
            NODE_ENV: 'production'
        }
    }]
};

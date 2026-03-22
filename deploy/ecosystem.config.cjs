/** PM2 example — adjust paths and args. */
module.exports = {
    apps: [
        {
            name: 'trading-bot',
            cwd: '/opt/trading-bot',
            script: 'npx',
            args: 'tsx index.ts BTCUSDT 5m --daemon',
            interpreter: 'none',
            autorestart: true,
            max_restarts: 20,
            min_uptime: '10s',
            env_file: '/opt/trading-bot/.env',
        },
    ],
};

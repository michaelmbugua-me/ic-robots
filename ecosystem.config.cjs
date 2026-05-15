module.exports = {
  apps: [
    {
      name: 'ic-scalping-bot',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      ignore_watch: ['node_modules', '*.json', 'history_*.json', 'activity.log'],
      env: {
        NODE_ENV: 'production',
        STRATEGY_MODE: 'ny_asian_continuation',
        TRADING_PAIRS: 'EUR_USD,GBP_USD,USD_JPY',
        SESSION_WINDOW_MODE: 'all_windows',
        RISK_PER_TRADE_PERCENT: '0.5',
        ENFORCE_DAILY_STOP_LOSS: 'true',
        DAILY_STOP_LOSS_KES: '300',
        DAILY_PROFIT_TARGET_KES: '300',
        NY_ASIAN_REQUIRE_H1_ALIGNMENT: 'true',
        NY_ASIAN_MAX_RISK_PIPS: '10',
        NY_ASIAN_RR_RATIO: '1.2'
      },
      args: '--auto-execute',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '500M',
      kill_timeout: 5000,
      restart_delay: 4000,
      listen_timeout: 3000,
      shutdown_with_message: true
    }
  ]
};


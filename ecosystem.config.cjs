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
        SESSION_WINDOW_MODE: 'all_windows',
        EMA_SEPARATION_MIN_PIPS: '0.5'
      },
      args: '--auto-execute',
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
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


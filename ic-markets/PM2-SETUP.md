# PM2 Process Management Setup

This project is configured to run with **pm2**, a Node.js process manager that provides:
- Automatic restarts on crashes
- Log aggregation
- Graceful shutdown handling
- Resource monitoring
- Persistent process state

## Installation

```bash
# Install dependencies (includes pm2)
pnpm install
```

## Starting the Bot

### Start with default configuration (ny_quality mode with auto-execute)
```bash
pnpm pm2:start
```

This uses the configuration from `ecosystem.config.cjs`:
- Mode: `ny_quality` 
- Auto-execute: enabled
- Logs: `logs/out.log` and `logs/err.log`

### Check process status
```bash
pnpm pm2:status
```

### View live logs
```bash
pnpm pm2:logs
```

### Stop the bot
```bash
pnpm pm2:stop
```

### Restart the bot
```bash
pnpm pm2:restart
```

### Remove bot from pm2
```bash
pnpm pm2:delete
```

### Kill all pm2 processes and daemon
```bash
pnpm pm2:kill
```

## Configuration

The bot is configured in `ecosystem.config.cjs`. Key settings:

```javascript
env: {
  NODE_ENV: 'production',
  SESSION_WINDOW_MODE: 'ny_quality',   // Change to: all_windows, ny_only, ny_trimmed, ny_quality
  EMA_SEPARATION_MIN_PIPS: '0.5'
},
args: '--auto-execute',  // Remove or comment out for monitor-only mode
```

### Customizing the Ecosystem Config

To use a different mode, edit `ecosystem.config.cjs` and restart:

```bash
# Example: Use all_windows mode
# Edit SESSION_WINDOW_MODE in ecosystem.config.cjs
pnpm pm2:restart

# Or delete and restart with new config
pnpm pm2:delete
pnpm pm2:start
```

## Log Management

Logs are stored in `logs/` directory:
- **out.log**: Standard output (trades, signals, status)
- **err.log**: Errors and warnings

View recent logs:
```bash
pnpm pm2:logs

# Or use tail directly
tail -f logs/out.log
tail -f logs/err.log
```

## Monitoring

```bash
# Real-time process monitoring
pm2 monit

# Save/restore process state
pm2 save
pm2 resurrect

# Start bot at system startup (requires permissions)
pm2 start ecosystem.config.cjs --update-env
sudo pm2 startup
pm2 save
```

## Troubleshooting

### Process keeps crashing
Check logs for errors:
```bash
pnpm pm2:logs
```

Increase restart delay in `ecosystem.config.js` if connection timeout issues occur.

### Logs not appearing
Make sure `logs/` directory exists:
```bash
mkdir -p logs
pnpm pm2:restart
```

### Port/connection conflicts
Verify IC Markets API credentials in `.env` and check network connectivity:
```bash
pnpm pm2:logs
```

## Automation Notes

- The bot uses **KES-denominated risk management** with daily P&L limits
- **Session hours**: 08:00–18:00 UTC (London + New York overlap)
- **Risk phases**: Global guardrails → Market environment → Trade execution → Error handling
- See `AGENTS.md` for full architecture details

## Next Steps

1. Ensure `.env` is properly configured with IC Markets credentials
2. Run `npm run auth` once for OAuth2 token
3. Run `pnpm pm2:start` to launch the bot
4. Monitor with `pnpm pm2:logs`


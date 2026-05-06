// PM2 ecosystem config for Doraemon bot.
// Deploy on the server with:
//   cd /path/to/bot/server
//   pm2 stop all && pm2 delete all     # clear any existing process
//   pm2 start ecosystem.config.js
//   pm2 save                            # persist process list
//   pm2 startup                         # then run the sudo command it prints

module.exports = {
  apps: [
    {
      name: 'doraemon',
      script: 'index.js',
      cwd: __dirname,

      // ---------- Restart policy ----------
      autorestart: true,
      // Restart proactively if RSS exceeds this — protects against slow leaks
      // before the OS OOM-killer steps in.
      max_memory_restart: '500M',
      // Exponential backoff between failing restarts: 100ms → 200 → 400 → ...
      // Prevents the "PM2 gives up after 10 instant retries" failure mode.
      exp_backoff_restart_delay: 100,
      // Process must stay up at least this long to count as a "successful" boot.
      // Anything that dies sooner counts toward max_restarts.
      min_uptime: '10s',
      // Total bad restarts allowed before PM2 stops trying. Pair with the
      // backoff above — by attempt 15 we'd have waited ~30 minutes total,
      // which is enough for transient infra issues to clear.
      max_restarts: 15,

      // ---------- Logs ----------
      // Relative paths resolve to cwd (the server/ dir).
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // ---------- Runtime ----------
      env: {
        NODE_ENV: 'production',
      },
      // Watch is off — we deploy by `git pull && pm2 restart all`, not by
      // file watching. Watching the whole tree would also restart on log
      // file writes, which would loop forever.
      watch: false,
    },
  ],
};

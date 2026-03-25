/**
 * PM2 ecosystem config for Banano Vibe Monitor (standalone)
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save         # persist across reboots
 *   pm2 startup      # enable auto-start on boot
 *   pm2 logs banano-vibe-standalone
 *   pm2 restart banano-vibe-standalone
 */

module.exports = {
  apps: [
    {
      name: "banano-vibe-standalone",
      script: "dist/standalone.js",
      cwd: __dirname,
      interpreter: "node",
      env_file: ".env",
      watch: false,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
    },
  ],
};

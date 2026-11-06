const name = 'biquote-stream'

module.exports = {
  apps: [
    {
      name,
      script: 'node ./dist/server.js',
      instances: 1, // single producer — multiple instances would duplicate vendor connections
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
      env_staging: {
        NODE_ENV: 'staging',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
}

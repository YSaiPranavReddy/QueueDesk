module.exports = {
  apps: [
    {
      name: 'queuedesk-server-1',
      script: './src/index.js',
      env: {
        PORT: 3001,
        NODE_ENV: 'development',
      },
    },
    {
      name: 'queuedesk-server-2',
      script: './src/index.js',
      env: {
        PORT: 3002,
        NODE_ENV: 'development',
      },
    },
    {
      name: 'queuedesk-server-3',
      script: './src/index.js',
      env: {
        PORT: 3003,
        NODE_ENV: 'development',
      },
    }
  ],
};

module.exports = {
  apps: [
    {
      name: "stempelo",
      script: "./server.js",
      env: {
        NODE_ENV: "production",
        PORT: 8055
      }
    }
  ]
};

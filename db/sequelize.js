const { Sequelize } = require('sequelize');
const config = require('config');

const sequelize = new Sequelize(
  config.get('db.name'),
  config.get('db.user'),
  config.get('db.pw'),
  {
    host: config.get('db.host'),
    port: config.get('db.port'),
    dialect: 'postgres',
    logging: false, // set this 'true' to see SQL logs
    dialectOptions: {
      // PostGIS extension is used for location data
      postgis: true,
      statement_timeout: config.get('db.pool.statementTimeoutMs'),
    },
    pool: {
      max: config.get('db.pool.max'),
      min: 2,
      acquire: config.get('db.pool.connectionTimeoutMs'),
      idle: config.get('db.pool.idleTimeoutMs'),
    }
  }
);

module.exports = sequelize;
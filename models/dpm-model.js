const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const DPM = sequelize.define('dpm', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 104,
  },
  sid: DataTypes.STRING,
  int_cr: DataTypes.STRING,
  rn: DataTypes.STRING,
  pi: DataTypes.STRING,
  et: DataTypes.STRING(20),
  ct: DataTypes.STRING(20),
  lt: DataTypes.STRING(20),
  acpi: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: null,
  },
  lbl: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: null,
  },
  cr: DataTypes.STRING,
  // resource specific attributes
  moid: DataTypes.STRING(255), // modelId
  mcmd: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // modelCommand = run/stop
  mds: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // modelStatus = deployed/running/stopped
  inr: DataTypes.STRING(255), // inputResource
  our: DataTypes.STRING(255), // outputResource
}, {
  tableName: 'dpm',
  timestamps: false,
});

module.exports = DPM;

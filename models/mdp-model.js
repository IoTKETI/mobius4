const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const MDP = sequelize.define('mdp', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 103,
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
  ndm: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // numberOfDeployedModels
  nrm: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // numberOfRunningModels
  nsm: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // numberOfStoppedModels
  dpm_list: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
  }, // list of children <deployments> resources
}, {
  tableName: 'mdp',
  timestamps: false,
});

module.exports = MDP;

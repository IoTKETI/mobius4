const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const CNT = sequelize.define('cnt', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 3,
  },
  sid: DataTypes.STRING,
  int_cr: DataTypes.STRING,
  rn: DataTypes.STRING,
  pi: DataTypes.STRING,
  et: DataTypes.STRING(20),
  ct: DataTypes.STRING(20),
  lt: DataTypes.STRING(20),
  acpi: DataTypes.ARRAY(DataTypes.STRING),
  lbl: DataTypes.ARRAY(DataTypes.STRING),
  st: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  cr: DataTypes.STRING,
  cni: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  cbs: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  mni: DataTypes.INTEGER,
  mbs: DataTypes.INTEGER,
  mia: DataTypes.INTEGER,
  cin_list: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
  },
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
}, {
  tableName: 'cnt',
  timestamps: false,
});

module.exports = CNT;
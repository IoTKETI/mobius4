const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const MRP = sequelize.define('mrp', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 101,
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
  cr: DataTypes.STRING,
  cnmo: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  cbmo: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  mnmo: DataTypes.INTEGER,
  mbmo: DataTypes.INTEGER,
  mmd_list: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
  },
}, {
  tableName: 'mrp',
  timestamps: false,
});

module.exports = MRP;
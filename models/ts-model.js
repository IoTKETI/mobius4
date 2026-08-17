const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');
const enums = require('../config/enums');

const TS = sequelize.define('ts', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    // BACKLOG-096: derived rather than re-typed, so this cannot drift from config/enums.js.
    defaultValue: enums.ty_num.ts,
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
  // stateTag is not in TS-0001:9.6.36's attribute table for <timeSeries> — see res_schema.js.
  cr: DataTypes.STRING,
  cni: { type: DataTypes.INTEGER, defaultValue: 0 },
  cbs: { type: DataTypes.INTEGER, defaultValue: 0 },
  mni: DataTypes.INTEGER,
  mbs: DataTypes.INTEGER,
  mia: DataTypes.INTEGER,
  // missing-data detection (TS-0001:10.2.4.29)
  pei: DataTypes.INTEGER,
  peid: DataTypes.INTEGER,
  mdd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  mdn: DataTypes.INTEGER,
  mdlt: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
  mdc: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  mdt: DataTypes.INTEGER,
  cnf: DataTypes.STRING,
  or: { type: DataTypes.STRING, field: 'or' },
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
  // internal bookkeeping — never serialised into a response
  md_anchor_dgt: DataTypes.STRING(20),
  md_watermark_n: DataTypes.INTEGER,
}, {
  tableName: 'ts',
  timestamps: false,
});

module.exports = TS;

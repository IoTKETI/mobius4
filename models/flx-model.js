const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const FLX = sequelize.define('flx', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 28,
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
  loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
  // <flexContainer> specific attributes (TS-0001:9.6.35 table 9.6.35-2)
  cnd: DataTypes.STRING,
  cs: DataTypes.INTEGER,
  nl: DataTypes.STRING,
  // 'or' (ontologyRef) is a reserved SQL keyword. Sequelize quotes every identifier, and
  // db/init.js quotes it explicitly in the DDL, so the short name is kept as the column name
  // for consistency with the rest of the schema.
  or: DataTypes.STRING,
  // Envelope key as received, e.g. 'sc:parkingBlock'. TS-0004:7.4.37.1 allows a specialization
  // to use a targetNamespace other than m2m:, and the original key has to be replayed on
  // RETRIEVE — nothing else in the resource records it.
  ek: DataTypes.STRING,
  // [customAttribute] values. The attribute set is defined by the document referenced by cnd
  // and is therefore unknown at build time, so it cannot be modelled as columns.
  custom: DataTypes.JSONB,
}, {
  tableName: 'flx',
  timestamps: false,
});

module.exports = FLX;

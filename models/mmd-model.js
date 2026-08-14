const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const MMD = sequelize.define('mmd', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 107,
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
  nm: DataTypes.STRING, // name
  vr: DataTypes.STRING, // version
  plf: DataTypes.STRING, // platform
  mlt: DataTypes.STRING, // mlType
  dc: DataTypes.STRING, // description
  ips: DataTypes.STRING, // inputSample
  ous: DataTypes.STRING, // outputSample
  // mlModel -- BACKLOG-087: stores the decoded model bytes (BYTEA), not the base64 text a
  // client sends. cse/resources/mmd.js decodes on CREATE/UPDATE and re-encodes to base64 on
  // RETRIEVE; mlModelSize (mms below) is this Buffer's own length.
  mmd: DataTypes.BLOB,
  mms: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, // mlModelSize
  mmu: DataTypes.STRING, // mlModelURL
}, {
  tableName: 'mmd',
  timestamps: false,
});

module.exports = MMD;

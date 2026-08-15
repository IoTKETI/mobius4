const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');
const enums = require('../config/enums');

const DTS = sequelize.define('dts', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    // BACKLOG-096: was a re-typed literal (105, <mlDatasetPolicy>'s number) that disagreed with
    // config/enums.js's ty_str table (106, <dataset>). Latent -- cse/resources/dts.js's
    // create_a_dts always sets ty explicitly.
    defaultValue: enums.ty_num.dts,
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
  dspi: DataTypes.STRING(255), // datasetPolicyID (Read Only)
  lof: DataTypes.ARRAY(DataTypes.STRING), // listOfFeatures (Read Only)
}, {
  tableName: 'dts',
  timestamps: false,
});

module.exports = DTS;
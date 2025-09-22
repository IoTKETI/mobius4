const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const DSP = sequelize.define('dsp', {
  ri: {
    type: DataTypes.STRING(24),
    primaryKey: true,
    allowNull: false,
  },
  ty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 105,
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
  sri: { // sourceResourceIDs
    type: DataTypes.ARRAY(DataTypes.STRING),
    allowNull: false,
  },
  dst: DataTypes.STRING(20), // datasetStartTime
  det: DataTypes.STRING(20), // datasetEndTime
  tcst: DataTypes.STRING(20), // timeCorrelationStartTime
  tcd: DataTypes.INTEGER, 
  nvp: { // nullValuePolicy
    type: DataTypes.INTEGER,
    defaultValue: 0,
  }, 
  dsfm: { // datasetFormat
    type:DataTypes.INTEGER, 
    allowNull: false,
  },
  hdi: DataTypes.STRING(255), // historicalDatasetId
  ldi: DataTypes.STRING(255), // liveDatasetId
  nrhd: DataTypes.INTEGER, // numberOfRowsForHistoricalDataset
  nrld: DataTypes.INTEGER, // numberOfRowsForLiveDataset
}, {
  tableName: 'dsp',
  timestamps: false,
});

module.exports = DSP;
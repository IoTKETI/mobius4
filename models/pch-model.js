const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const PCH = sequelize.define('pch', {
    ri: {
        type: DataTypes.STRING(24),
        primaryKey: true,
        allowNull: false,
    },
    ty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 15,
    },
    sid: DataTypes.STRING,
    int_cr: DataTypes.STRING,
    rn: DataTypes.STRING,
    pi: DataTypes.STRING,
    et: DataTypes.STRING(20),
    ct: DataTypes.STRING(20),
    lt: DataTypes.STRING(20),

    lbl: DataTypes.ARRAY(DataTypes.STRING),
    rqag: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    reqs: {
        type: DataTypes.JSONB,
        defaultValue: [],
    },
}, {
    tableName: 'pch',
    timestamps: false,
});

module.exports = PCH;
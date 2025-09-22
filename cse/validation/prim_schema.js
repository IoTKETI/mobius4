/**
 * @description defines schemas for request primitve
 */

const Joi = require('joi');

const req_prim_schema = Joi.object().keys({
    op: Joi.number().integer().allow(1, 2, 3, 4, 5).required(),
    to: Joi.string().required(),
    fr: Joi.string().optional(),
    user: Joi.string().optional(),
    rqi: Joi.string().required(),
    ty: Joi.number().integer().when('op', {
        is: Joi.allow(2, 3, 4, 5),
        then: Joi.optional(),
        otherwise: Joi.required()
    }),
    pc: Joi.optional(),
    ot: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    rt: Joi.object().optional().keys({
        rtv: Joi.string().allow(1, 2, 3, 4, 5).required(),
        nu: Joi.string().optional()
    }),
    rcn: Joi.number().integer().min(0).max(10).optional(),
    gid: Joi.string().optional(),
    fc: Joi.object().optional().keys({
        fu: Joi.number().integer().min(1).max(3).optional(),
        crb: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        cra: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        ms: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        us: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        sts: Joi.number().integer().min(0),
        stb: Joi.number().integer().min(0),
        exb: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        exa: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
        rn: Joi.string().optional(),
        cr: Joi.string().optional(),
        lbl: Joi.array().items(Joi.string()).optional(),
        ty: Joi.array().optional().items(Joi.number().integer().required()),
        cty: Joi.string().optional(),
        lvl: Joi.number().integer().min(1),
        lim: Joi.number().integer().min(0),
        ofst: Joi.number().integer().min(1),
        gmty: Joi.number().optional(),
        gsf: Joi.number().integer().min(1).max(3).optional(),
        geom: Joi.array().optional(),
        smf: Joi.string().optional(),
        or: Joi.array().items(Joi.string().optional()).optional(),
    }),
    drt: Joi.number().integer().min(1).max(2).optional(),
    sqi: Joi.boolean().optional(),
    rvi: Joi.string().optional(), // rel-1 AEs can omit this
    vsi: Joi.string().optional()
});

const resp_prim_schema = Joi.object().keys({
    rcs: Joi.number().integer().required(),
    rqi: Joi.string().required(),
    to: Joi.string().optional(),
    fr: Joi.string().optional(),
    pc: Joi.optional(),
    ot: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    ofst: Joi.number().integer().min(1),
    cnst: Joi.number().integer().min(1).max(2).optional(),
    rvi: Joi.string().required(),
    vsi: Joi.string().optional()
});


module.exports = {
    req_prim_schema, resp_prim_schema
}
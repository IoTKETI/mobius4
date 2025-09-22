const { customAlphabet } = require('nanoid');
const moment = require('moment');
const config = require('config');

const timestamp_format = config.get('cse.timestamp_format');
const enums = require('../config/enums');
const pool = require('../db/connection');

const generate_ri = customAlphabet(config.cse.allowed_ri_characters, config.length.ri);

function get_cur_time () {
  return moment().utc().format(timestamp_format);
}

function get_default_et () {
  return moment().utc().add(config.default.common.et_month, 'month').format(timestamp_format);
}

function get_geometryType_from_enum(typ) {
  switch (typ) {
    case 1: return "Point";
    case 2: return "LineString";
    case 3: return "Polygon";
    case 4: return "MultiPoint";
    case 5: return "MultiLineString";
    case 6: return "MultiPolygon";
    default: return null;
  }
}

async function convert_loc_to_geoJson(prim_res, resp_prim) {
  const geometry_type = get_geometryType_from_enum(prim_res.loc.typ);
  const coordinates = get_coordinates_from_string(prim_res.loc.crd);

  if (coordinates === null) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'invalid location coordinates' };
    return;
  }
  if (geometry_type === null) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'invalid location type' };
    return;
  }
  prim_res.loc = {
    type: geometry_type,
    coordinates: coordinates
  };

  // validate geometry with PostGIS
  const isValid = await validate_geometry_with_postgis(prim_res.loc, resp_prim);
  if (!isValid) {
    return; 
  }
}

// example crd in text format: '[[100.0, 0.0], [101.0, 1.0]]'
// expected crd_json: [ [100.0, 0.0], [101.0, 1.0] ]
function get_coordinates_from_string(crd) {
  try {
    const crd_json = JSON.parse(crd);
    return crd_json;
  } catch (error) {
    return null;
  }
}

function get_geometryEnum_from_type(type) {
  switch (type) {
    case "Point": return 1;
    case "LineString": return 2;
    case "Polygon": return 3;
    case "MultiPoint": return 4;
    case "MultiLineString": return 5;
    case "MultiPolygon": return 6;
    default: return null;
  }
}

async function validate_geometry_with_postgis(geojson, resp_prim) {
  try {
    const query = `
      WITH geom AS (
        SELECT ST_GeomFromGeoJSON($1) as geometry
      )
      SELECT 
        ST_IsValid(geometry) as is_valid,
        ST_IsValidReason(geometry) as reason,
        ST_IsSimple(geometry) as is_simple,
        ST_IsClosed(geometry) as is_closed
      FROM geom
    `;

    const result = await pool.query(query, [JSON.stringify(geojson)]);

    if (result.rows.length === 0) {
      resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
      resp_prim.pc = { 'm2m:dbg': 'geometry validation query failed' };
      return false;
    }

    const { is_valid, reason, is_simple, is_closed } = result.rows[0];

    // basic validation
    if (!is_valid) {
      resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
      resp_prim.pc = { 'm2m:dbg': `invalid geometry: ${reason}` };
      return false;
    }

    // additional validation for Polygon
    if (geojson.type === 'Polygon') {
      // simple validation (self-intersecting)
      if (!is_simple) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'Polygon is not simple (self-intersecting)' };
        return false;
      }

      // closed curve validation
      if (!is_closed) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'Polygon is not closed (first and last points must be identical)' };
        return false;
      }

              // additional validation with PostGIS's ST_IsValidDetail
        const detailQuery = `
          SELECT 
            (ST_IsValidDetail(ST_GeomFromGeoJSON($1))).valid as is_valid_detail,
            (ST_IsValidDetail(ST_GeomFromGeoJSON($1))).reason as reason_detail,
            (ST_IsValidDetail(ST_GeomFromGeoJSON($1))).location as location_detail
          FROM (SELECT 1) as dummy
        `;
        
        const detailResult = await pool.query(detailQuery, [JSON.stringify(geojson)]);
        
        if (detailResult.rows.length > 0) {
          const { is_valid_detail, reason_detail, location_detail } = detailResult.rows[0];
          
          if (!is_valid_detail) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': `detailed validation failed: ${reason_detail || 'unknown error'}` };
            return false;
          }
        }
    }

    return true;

  } catch (error) {
    console.error('PostGIS geometry validation error:', error);

    // extract useful information from PostGIS error message
    let errorMessage = 'geometry validation failed';
    if (error.message) {
      if (error.message.includes('unknown GeoJSON type')) {
        errorMessage = 'unsupported or malformed GeoJSON type';
      } else if (error.message.includes('invalid coordinates')) {
        errorMessage = 'invalid coordinate values';
      } else if (error.message.includes('parse error')) {
        errorMessage = 'malformed geometry data';
      } else {
        errorMessage = error.message;
      }
    }

    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': errorMessage };
    return false;
  }
}

function get_loc_attribute(db_loc) {
  return {
    typ: get_geometryEnum_from_type(db_loc.type),
    crd: JSON.stringify(db_loc.coordinates)
  };
}

module.exports = {
  generate_ri,
  get_cur_time,
  get_default_et,
  convert_loc_to_geoJson,
  get_loc_attribute,
};
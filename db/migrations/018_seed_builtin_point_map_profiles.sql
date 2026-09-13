-- 018_seed_builtin_point_map_profiles.sql
-- Seeds point_map_profiles with the built-in profiles the docs (OPERATIONS_MANUAL.md, step 3 of
-- onboarding a relay) already promise: Siemens SIPROTEC, ABB/Hitachi Energy REx, Schneider MiCOM,
-- SEL and GE Multilin.
--
-- WHY: apps/edge-gateway/src/protocols/pointMap.ts has always shipped these as BUILT_IN_POINT_MAPS
-- for the gateway driver's own use, but nothing ever inserted the matching rows into this table.
-- The provisioning UI's point-map dropdown (GET /api/comms/point-maps) reads only from this table,
-- so on a fresh database the dropdown is empty and any Modbus/DNP3/IEC 60870 relay is permanently
-- blocked at "Assign a point-map profile, or no data can be interpreted" with nothing to assign.
-- profile_id values below must stay identical to the keys of BUILT_IN_POINT_MAPS so a relay
-- provisioned against one of these rows resolves to the same driver-side map at runtime.

INSERT INTO point_map_profiles (profile_id, display_name, manufacturer, models, points, is_built_in) VALUES
('siemens-siprotec-generic', 'Siemens SIPROTEC (generic)', 'Siemens',
 ARRAY['SIPROTEC 5 7SJ82', 'SIPROTEC 5 7SA82', 'SIPROTEC 4 7SJ64'],
 '{
   "IEC60870_5_104": [
     {"address": 1, "name": "breaker_position", "kind": "BREAKER_POSITION"},
     {"address": 100, "name": "current_A", "kind": "MEASUREMENT", "scale": 1, "unit": "A"},
     {"address": 101, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV"},
     {"address": 102, "name": "frequency_Hz", "kind": "MEASUREMENT", "scale": 0.01, "unit": "Hz"},
     {"address": 200, "name": "overcurrent_pickup", "kind": "PROTECTION_PICKUP", "protectionFunction": "OVERCURRENT"},
     {"address": 201, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"},
     {"address": 202, "name": "earth_fault_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "EARTH_FAULT"},
     {"address": 300, "name": "device_alarm", "kind": "DEVICE_HEALTH"}
   ],
   "MODBUS_TCP": [
     {"address": 30001, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A", "dataType": "UINT32", "registerTable": "INPUT"},
     {"address": 30003, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV", "dataType": "UINT32", "registerTable": "INPUT"},
     {"address": 30005, "name": "frequency_Hz", "kind": "MEASUREMENT", "scale": 0.01, "unit": "Hz", "dataType": "UINT16", "registerTable": "INPUT"},
     {"address": 10001, "name": "breaker_position", "kind": "BREAKER_POSITION", "dataType": "BOOL", "registerTable": "DISCRETE_INPUT"},
     {"address": 10010, "name": "trip_indication", "kind": "PROTECTION_TRIP", "dataType": "BOOL", "registerTable": "DISCRETE_INPUT", "protectionFunction": "OVERCURRENT"}
   ],
   "IEC60870_5_103": [
     {"address": 84, "name": "general_start", "kind": "PROTECTION_PICKUP"},
     {"address": 68, "name": "general_trip", "kind": "PROTECTION_TRIP"},
     {"address": 90, "name": "trip_L1", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"},
     {"address": 91, "name": "trip_L2", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"},
     {"address": 92, "name": "trip_L3", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"},
     {"address": 93, "name": "trip_earth", "kind": "PROTECTION_TRIP", "protectionFunction": "EARTH_FAULT"},
     {"address": 16, "name": "auto_reclose_active", "kind": "DEVICE_HEALTH"},
     {"address": 19, "name": "led_reset", "kind": "DEVICE_HEALTH"}
   ]
 }'::jsonb, true),

('abb-ref-generic', 'ABB / Hitachi Energy REF-REx (generic)', 'ABB',
 ARRAY['REF615', 'RET615', 'REL650', 'RED670', 'REC670', 'RET670'],
 '{
   "IEC60870_5_104": [
     {"address": 1, "name": "breaker_position", "kind": "BREAKER_POSITION"},
     {"address": 110, "name": "current_A", "kind": "MEASUREMENT", "scale": 1, "unit": "A"},
     {"address": 111, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV"},
     {"address": 210, "name": "differential_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "TRANSFORMER_DIFFERENTIAL"},
     {"address": 211, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"}
   ],
   "SPA_BUS": [
     {"address": 1, "name": "current_A", "kind": "MEASUREMENT", "scale": 1, "unit": "A"},
     {"address": 2, "name": "breaker_position", "kind": "BREAKER_POSITION"},
     {"address": 3, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"}
   ],
   "MODBUS_TCP": [
     {"address": 40001, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A", "dataType": "UINT32", "registerTable": "HOLDING"},
     {"address": 40003, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV", "dataType": "UINT32", "registerTable": "HOLDING"},
     {"address": 40010, "name": "status_word", "kind": "BREAKER_POSITION", "dataType": "UINT16", "registerTable": "HOLDING", "bitOffset": 0}
   ]
 }'::jsonb, true),

('schneider-micom-generic', 'Schneider Electric MiCOM / Easergy (generic)', 'Schneider Electric',
 ARRAY['MiCOM P123', 'MiCOM P443', 'Easergy P3'],
 '{
   "MODBUS_TCP": [
     {"address": 30016, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.01, "unit": "A", "dataType": "UINT32", "registerTable": "INPUT"},
     {"address": 30020, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV", "dataType": "UINT32", "registerTable": "INPUT"},
     {"address": 30024, "name": "frequency_Hz", "kind": "MEASUREMENT", "scale": 0.01, "unit": "Hz", "dataType": "UINT16", "registerTable": "INPUT"},
     {"address": 10001, "name": "breaker_position", "kind": "BREAKER_POSITION", "dataType": "BOOL", "registerTable": "DISCRETE_INPUT"},
     {"address": 10005, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP", "dataType": "BOOL", "registerTable": "DISCRETE_INPUT", "protectionFunction": "OVERCURRENT"},
     {"address": 10006, "name": "earth_fault_trip", "kind": "PROTECTION_TRIP", "dataType": "BOOL", "registerTable": "DISCRETE_INPUT", "protectionFunction": "EARTH_FAULT"}
   ],
   "COURIER": [
     {"address": 513, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.01, "unit": "A"},
     {"address": 2049, "name": "general_trip", "kind": "PROTECTION_TRIP"}
   ]
 }'::jsonb, true),

('sel-generic', 'SEL (generic)', 'SEL',
 ARRAY['SEL-751', 'SEL-421', 'SEL-587Z'],
 '{
   "DNP3_TCP": [
     {"address": 0, "name": "breaker_position", "kind": "BREAKER_POSITION"},
     {"address": 1, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "OVERCURRENT"},
     {"address": 2, "name": "earth_fault_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "EARTH_FAULT"},
     {"address": 3, "name": "relay_trouble", "kind": "DEVICE_HEALTH"},
     {"address": 4096, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A"},
     {"address": 4097, "name": "voltage_kV", "kind": "MEASUREMENT", "scale": 0.001, "unit": "kV"},
     {"address": 4098, "name": "frequency_Hz", "kind": "MEASUREMENT", "scale": 0.01, "unit": "Hz"}
   ],
   "SEL_ASCII": [
     {"address": 0, "name": "current_A", "kind": "MEASUREMENT", "unit": "A"},
     {"address": 1, "name": "voltage_kV", "kind": "MEASUREMENT", "unit": "kV"},
     {"address": 2, "name": "frequency_Hz", "kind": "MEASUREMENT", "unit": "Hz"}
   ]
 }'::jsonb, true),

('ge-multilin-generic', 'GE Multilin (generic)', 'GE Multilin',
 ARRAY['GE F60', 'GE B90', 'GE 850'],
 '{
   "DNP3_TCP": [
     {"address": 0, "name": "breaker_position", "kind": "BREAKER_POSITION"},
     {"address": 4, "name": "busbar_differential_trip", "kind": "PROTECTION_TRIP", "protectionFunction": "BUSBAR_DIFFERENTIAL"},
     {"address": 8192, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A"}
   ],
   "MODBUS_TCP": [
     {"address": 40001, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A", "dataType": "UINT32", "registerTable": "HOLDING"},
     {"address": 40100, "name": "breaker_position", "kind": "BREAKER_POSITION", "dataType": "UINT16", "registerTable": "HOLDING", "bitOffset": 0}
   ],
   "GE_EGD": [
     {"address": 0, "name": "current_A", "kind": "MEASUREMENT", "scale": 0.1, "unit": "A", "dataType": "FLOAT32"},
     {"address": 4, "name": "breaker_position", "kind": "BREAKER_POSITION", "dataType": "BOOL"}
   ]
 }'::jsonb, true)

ON CONFLICT (profile_id) DO NOTHING;

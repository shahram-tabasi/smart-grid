/**
 * IEC 60870-5 ASDU encoding/decoding, shared by the -104 (TCP), -101 (serial) and -103
 * (protection companion standard) drivers.
 *
 * Only the MONITOR DIRECTION is implemented. There is deliberately no encoder for any command
 * ASDU type (C_SC_NA_1 single command, C_DC_NA_1 double command, C_RC_NA_1 regulating step,
 * C_SE_* setpoints, C_BO_* bitstring). A control action cannot be expressed by this module, so it
 * cannot be emitted by anything built on top of it.
 */

// ---------------------------------------------------------------------------------------------
// Type identifiers (monitor direction only)
// ---------------------------------------------------------------------------------------------

export enum TypeId {
  M_SP_NA_1 = 1, // single-point information
  M_SP_TA_1 = 2, // single-point with CP24Time2a
  M_DP_NA_1 = 3, // double-point information
  M_DP_TA_1 = 4, // double-point with CP24Time2a
  M_ST_NA_1 = 5, // step position
  M_BO_NA_1 = 7, // bitstring of 32 bits
  M_ME_NA_1 = 9, // measured value, normalized
  M_ME_NB_1 = 11, // measured value, scaled
  M_ME_NC_1 = 13, // measured value, short float
  M_IT_NA_1 = 15, // integrated totals
  M_SP_TB_1 = 30, // single-point with CP56Time2a
  M_DP_TB_1 = 31, // double-point with CP56Time2a
  M_ST_TB_1 = 32, // step position with CP56Time2a
  M_BO_TB_1 = 33, // bitstring with CP56Time2a
  M_ME_TD_1 = 34, // normalized with CP56Time2a
  M_ME_TE_1 = 35, // scaled with CP56Time2a
  M_ME_TF_1 = 36, // short float with CP56Time2a
  M_IT_TB_1 = 37, // integrated totals with CP56Time2a
  M_EP_TD_1 = 38, // protection equipment event with CP56Time2a
  M_EP_TE_1 = 39, // protection equipment packed start events
  M_EP_TF_1 = 40, // protection equipment packed output circuit info
  M_EI_NA_1 = 70, // end of initialisation
  C_IC_NA_1 = 100, // interrogation command — request only, see note below
  C_CI_NA_1 = 101, // counter interrogation
  C_CS_NA_1 = 103, // clock synchronisation (read/compare only here)
}

/**
 * C_IC_NA_1 (station interrogation) is a request for data, not a control of plant. It is the only
 * outbound type this module can build, and buildInterrogationAsdu() below hard-codes it — there is
 * no general-purpose "build any command" function.
 */

export enum CauseOfTransmission {
  PERIODIC = 1,
  BACKGROUND_SCAN = 2,
  SPONTANEOUS = 3,
  INITIALIZED = 4,
  REQUEST = 5,
  ACTIVATION = 6,
  ACTIVATION_CONFIRMATION = 7,
  DEACTIVATION = 8,
  ACTIVATION_TERMINATION = 10,
  INTERROGATED_BY_STATION = 20,
}

export interface DecodedInformationObject {
  ioa: number; // information object address
  value: number | boolean | null;
  /** Present when the type carries a time tag. */
  timestamp?: Date;
  /** Quality descriptor bits, decoded. */
  quality?: {
    invalid: boolean;
    notTopical: boolean;
    substituted: boolean;
    blocked: boolean;
    overflow?: boolean;
  };
  /** For double-point types: the raw DPI value (0=indeterminate,1=off,2=on,3=indeterminate). */
  doublePoint?: number;
  /** For protection event types: the elapsed time and the single event state. */
  protectionEvent?: { elapsedMs: number; state: number };
}

export interface DecodedAsdu {
  typeId: TypeId;
  typeName: string;
  sequence: boolean;
  numberOfObjects: number;
  causeOfTransmission: CauseOfTransmission;
  negative: boolean;
  test: boolean;
  originatorAddress: number;
  commonAddress: number; // ASDU address = the station
  objects: DecodedInformationObject[];
}

// ---------------------------------------------------------------------------------------------
// Time decoding
// ---------------------------------------------------------------------------------------------

/**
 * CP56Time2a — 7 bytes, millisecond resolution. This is what makes a genuine millisecond fault
 * timeline possible on a -104 link.
 */
export function decodeCP56Time2a(buf: Buffer, offset: number): Date {
  const ms = buf.readUInt16LE(offset);
  const minute = buf[offset + 2] & 0x3f;
  const hour = buf[offset + 3] & 0x1f;
  const day = buf[offset + 4] & 0x1f;
  const month = (buf[offset + 5] & 0x0f) - 1;
  // Two-digit year: the standard's 7-bit year field. Windowed at 70 to match utility practice.
  const rawYear = buf[offset + 6] & 0x7f;
  const year = rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear;
  const seconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000;
  return new Date(Date.UTC(year, month, day, hour, minute, seconds, milliseconds));
}

/** CP24Time2a — 3 bytes, milliseconds + minutes only. The hour and date come from the receiver. */
export function decodeCP24Time2a(buf: Buffer, offset: number, reference = new Date()): Date {
  const ms = buf.readUInt16LE(offset);
  const minute = buf[offset + 2] & 0x3f;
  const d = new Date(reference);
  d.setUTCMinutes(minute, Math.floor(ms / 1000), ms % 1000);
  return d;
}

function decodeQuality(qds: number) {
  return {
    overflow: (qds & 0x01) !== 0,
    blocked: (qds & 0x10) !== 0,
    substituted: (qds & 0x20) !== 0,
    notTopical: (qds & 0x40) !== 0,
    invalid: (qds & 0x80) !== 0,
  };
}

// ---------------------------------------------------------------------------------------------
// ASDU decoding
// ---------------------------------------------------------------------------------------------

/** Byte-width of the element that follows the IOA, per type. */
function elementSize(typeId: TypeId): number {
  switch (typeId) {
    case TypeId.M_SP_NA_1:
    case TypeId.M_DP_NA_1:
      return 1;
    case TypeId.M_SP_TA_1:
    case TypeId.M_DP_TA_1:
      return 4; // value + CP24Time2a
    case TypeId.M_ST_NA_1:
      return 2;
    case TypeId.M_BO_NA_1:
      return 5;
    case TypeId.M_ME_NA_1:
    case TypeId.M_ME_NB_1:
      return 3; // 2-byte value + QDS
    case TypeId.M_ME_NC_1:
      return 5; // 4-byte float + QDS
    case TypeId.M_IT_NA_1:
      return 5;
    case TypeId.M_SP_TB_1:
    case TypeId.M_DP_TB_1:
      return 8; // value + CP56Time2a
    case TypeId.M_ST_TB_1:
      return 9;
    case TypeId.M_BO_TB_1:
      return 12;
    case TypeId.M_ME_TD_1:
    case TypeId.M_ME_TE_1:
      return 10; // 2-byte value + QDS + CP56Time2a
    case TypeId.M_ME_TF_1:
      return 12; // 4-byte float + QDS + CP56Time2a
    case TypeId.M_IT_TB_1:
      return 12;
    case TypeId.M_EP_TD_1:
      return 10; // SEP + elapsed(2) + CP56Time2a
    case TypeId.M_EI_NA_1:
      return 1;
    case TypeId.C_IC_NA_1:
    case TypeId.C_CI_NA_1:
      return 1;
    default:
      return 1;
  }
}

/**
 * Decode one ASDU. `ioaSize` and `cotSize`/`caSize` are configurable because utilities genuinely
 * differ: Iranian utility practice is commonly 3-byte IOA, 2-byte COT, 2-byte common address, but
 * the driver reads these from site configuration rather than assuming.
 */
export function decodeAsdu(
  buf: Buffer,
  opts: { ioaSize?: 1 | 2 | 3; cotSize?: 1 | 2; caSize?: 1 | 2 } = {}
): DecodedAsdu {
  const ioaSize = opts.ioaSize ?? 3;
  const cotSize = opts.cotSize ?? 2;
  const caSize = opts.caSize ?? 2;

  let p = 0;
  const typeId = buf[p++] as TypeId;
  const vsq = buf[p++];
  const numberOfObjects = vsq & 0x7f;
  const sequence = (vsq & 0x80) !== 0;

  const cotByte = buf[p++];
  const causeOfTransmission = (cotByte & 0x3f) as CauseOfTransmission;
  const negative = (cotByte & 0x40) !== 0;
  const test = (cotByte & 0x80) !== 0;
  const originatorAddress = cotSize === 2 ? buf[p++] : 0;

  let commonAddress = 0;
  if (caSize === 1) commonAddress = buf[p++];
  else {
    commonAddress = buf.readUInt16LE(p);
    p += 2;
  }

  const objects: DecodedInformationObject[] = [];
  const readIoa = (): number => {
    let ioa = 0;
    if (ioaSize === 1) ioa = buf[p];
    else if (ioaSize === 2) ioa = buf.readUInt16LE(p);
    else ioa = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += ioaSize;
    return ioa;
  };

  let baseIoa = 0;
  for (let i = 0; i < numberOfObjects; i++) {
    // In sequence mode the IOA appears once and increments per element.
    let ioa: number;
    if (sequence) {
      if (i === 0) baseIoa = readIoa();
      ioa = baseIoa + i;
    } else {
      ioa = readIoa();
    }

    if (p + elementSize(typeId) > buf.length) break; // truncated frame — stop rather than throw
    const obj = decodeElement(typeId, buf, p, ioa);
    p += elementSize(typeId);
    objects.push(obj);
  }

  return {
    typeId,
    typeName: TypeId[typeId] ?? `UNKNOWN_${typeId}`,
    sequence,
    numberOfObjects,
    causeOfTransmission,
    negative,
    test,
    originatorAddress,
    commonAddress,
    objects,
  };
}

function decodeElement(typeId: TypeId, buf: Buffer, p: number, ioa: number): DecodedInformationObject {
  switch (typeId) {
    case TypeId.M_SP_NA_1: {
      const siq = buf[p];
      return { ioa, value: (siq & 0x01) !== 0, quality: decodeQuality(siq & 0xf0) };
    }
    case TypeId.M_SP_TB_1: {
      const siq = buf[p];
      return {
        ioa,
        value: (siq & 0x01) !== 0,
        quality: decodeQuality(siq & 0xf0),
        timestamp: decodeCP56Time2a(buf, p + 1),
      };
    }
    case TypeId.M_DP_NA_1: {
      const diq = buf[p];
      const dpi = diq & 0x03;
      return { ioa, value: dpi === 2, doublePoint: dpi, quality: decodeQuality(diq & 0xf0) };
    }
    case TypeId.M_DP_TB_1: {
      const diq = buf[p];
      const dpi = diq & 0x03;
      return {
        ioa,
        value: dpi === 2,
        doublePoint: dpi,
        quality: decodeQuality(diq & 0xf0),
        timestamp: decodeCP56Time2a(buf, p + 1),
      };
    }
    case TypeId.M_ME_NA_1: {
      // Normalized: signed 16-bit scaled to [-1, 1).
      const raw = buf.readInt16LE(p);
      return { ioa, value: raw / 32768, quality: decodeQuality(buf[p + 2]) };
    }
    case TypeId.M_ME_TD_1: {
      const raw = buf.readInt16LE(p);
      return {
        ioa,
        value: raw / 32768,
        quality: decodeQuality(buf[p + 2]),
        timestamp: decodeCP56Time2a(buf, p + 3),
      };
    }
    case TypeId.M_ME_NB_1: {
      return { ioa, value: buf.readInt16LE(p), quality: decodeQuality(buf[p + 2]) };
    }
    case TypeId.M_ME_TE_1: {
      return {
        ioa,
        value: buf.readInt16LE(p),
        quality: decodeQuality(buf[p + 2]),
        timestamp: decodeCP56Time2a(buf, p + 3),
      };
    }
    case TypeId.M_ME_NC_1: {
      return { ioa, value: buf.readFloatLE(p), quality: decodeQuality(buf[p + 4]) };
    }
    case TypeId.M_ME_TF_1: {
      return {
        ioa,
        value: buf.readFloatLE(p),
        quality: decodeQuality(buf[p + 4]),
        timestamp: decodeCP56Time2a(buf, p + 5),
      };
    }
    case TypeId.M_ST_NA_1: {
      const vti = buf[p];
      const signed = vti & 0x7f;
      return { ioa, value: signed > 63 ? signed - 128 : signed, quality: decodeQuality(buf[p + 1]) };
    }
    case TypeId.M_IT_NA_1: {
      return { ioa, value: buf.readInt32LE(p) };
    }
    case TypeId.M_EP_TD_1: {
      // Protection equipment event: SEP byte, elapsed time (2 bytes), CP56Time2a.
      const sep = buf[p];
      return {
        ioa,
        value: sep & 0x03,
        protectionEvent: { state: sep & 0x03, elapsedMs: buf.readUInt16LE(p + 1) },
        quality: decodeQuality(sep & 0xf0),
        timestamp: decodeCP56Time2a(buf, p + 3),
      };
    }
    case TypeId.M_EI_NA_1: {
      return { ioa, value: buf[p] };
    }
    default:
      return { ioa, value: null };
  }
}

// ---------------------------------------------------------------------------------------------
// The one thing we are allowed to send: a request for data
// ---------------------------------------------------------------------------------------------

/**
 * Builds a C_IC_NA_1 general (station) interrogation. This asks the station to report its current
 * data; it does not operate anything. It is the ONLY ASDU this codebase can construct — there is
 * no encoder for single/double commands, setpoints or regulating steps anywhere in the module.
 */
export function buildInterrogationAsdu(
  commonAddress: number,
  opts: { qoi?: number; cotSize?: 1 | 2; caSize?: 1 | 2; ioaSize?: 1 | 2 | 3 } = {}
): Buffer {
  const cotSize = opts.cotSize ?? 2;
  const caSize = opts.caSize ?? 2;
  const ioaSize = opts.ioaSize ?? 3;
  const qoi = opts.qoi ?? 20; // 20 = station interrogation (global)

  const buf = Buffer.alloc(2 + cotSize + caSize + ioaSize + 1);
  let p = 0;
  buf[p++] = TypeId.C_IC_NA_1;
  buf[p++] = 1; // one information object, not a sequence
  buf[p++] = CauseOfTransmission.ACTIVATION;
  if (cotSize === 2) buf[p++] = 0; // originator address
  if (caSize === 1) buf[p++] = commonAddress & 0xff;
  else {
    buf.writeUInt16LE(commonAddress, p);
    p += 2;
  }
  // IOA is always 0 for an interrogation command.
  for (let i = 0; i < ioaSize; i++) buf[p++] = 0;
  buf[p++] = qoi;
  return buf;
}

import forge from 'node-forge/lib/forge.js';
import 'node-forge/lib/pki.js';
import 'node-forge/lib/pkcs7.js';
import 'node-forge/lib/pkcs12.js';

// PDF Tools already loads the pinned, local pdf-lib runtime before mounting
// the workbench. Reuse that runtime here instead of embedding a second copy in
// the certificate-signature lazy chunk.
const {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
  degrees,
  drawImage,
  drawRectangle,
  drawText,
  rgb,
} = globalThis.PDFLib || {};

const DEFAULT_SIGNATURE_PLACEHOLDER_BYTES = 32768;
const BYTE_RANGE_SENTINELS = Object.freeze([1111111111, 2222222222, 3333333333]);
const CONTENTS_SENTINEL = 'F17E';
const MAX_PKCS12_BYTES = 10 * 1024 * 1024;
const MAX_PEM_CHARACTERS = 4 * 1024 * 1024;

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value || []);
}

function bytesToBinary(bytes) {
  const source = asUint8Array(bytes);
  const chunkSize = 0x8000;
  let output = '';
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    output += String.fromCharCode(...source.subarray(offset, offset + chunkSize));
  }
  return output;
}

function binaryToBytes(binary) {
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index) & 0xff;
  return output;
}

function concatenateBytes(...parts) {
  const arrays = parts.map(asUint8Array);
  const output = new Uint8Array(arrays.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of arrays) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pdfText(value) {
  return PDFHexString.fromText(String(value || ''));
}

function pdfDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = number => String(number).padStart(2, '0');
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `D:${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}` +
    `${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}` +
    `${sign}${pad(Math.floor(absoluteOffset / 60))}'${pad(absoluteOffset % 60)}'`;
}

function certificateCommonName(certificate) {
  return certificate?.subject?.getField?.('CN')?.value ||
    certificate?.subject?.attributes?.map(attribute => attribute.value).filter(Boolean).join(', ') ||
    'Certificate signer';
}

function certificateMatchesPrivateKey(certificate, privateKey) {
  const publicKey = certificate?.publicKey;
  if (!publicKey?.n || !publicKey?.e || !privateKey?.n || !privateKey?.e) return false;
  return publicKey.n.compareTo(privateKey.n) === 0 && publicKey.e.compareTo(privateKey.e) === 0;
}

function requireMatchingRsaCredential(privateKey, certificates) {
  if (!privateKey?.n || !privateKey?.d) {
    throw new Error('Only RSA private keys are supported for local PDF signing.');
  }
  const certificate = certificates.find(item => certificateMatchesPrivateKey(item, privateKey));
  if (!certificate) throw new Error('The certificate does not match the selected private key.');
  return { privateKey, certificate, certificates };
}

function parsePkcs12Credential(data, password = '') {
  if (asUint8Array(data).length > MAX_PKCS12_BYTES) {
    throw new Error('The PKCS#12 file exceeds the 10 MB local signing limit.');
  }
  try {
    const asn1 = forge.asn1.fromDer(bytesToBinary(data));
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const privateKeys = keyBags.map(bag => bag.key).filter(Boolean);
    const certificates = certBags.map(bag => bag.cert).filter(Boolean);
    if (!privateKeys.length) throw new Error('The PKCS#12 file contains no private key.');
    if (!certificates.length) throw new Error('The PKCS#12 file contains no X.509 certificate.');
    const privateKey = privateKeys.find(key => certificates.some(certificate => certificateMatchesPrivateKey(certificate, key)));
    if (!privateKey) throw new Error('The certificate does not match any private key in the PKCS#12 file.');
    return requireMatchingRsaCredential(privateKey, certificates);
  } catch (error) {
    if (/contains no|does not match|Only RSA/.test(error?.message || '')) throw error;
    throw new Error('The PKCS#12 file or its password is invalid.');
  }
}

function parsePrivateKeyPem(privateKeyPem, password = '') {
  const pem = String(privateKeyPem || '').trim();
  if (!pem) throw new Error('Choose a PEM private key.');
  if (pem.length > MAX_PEM_CHARACTERS) throw new Error('The PEM private key exceeds the 4 MB local signing limit.');
  try {
    if (/BEGIN ENCRYPTED PRIVATE KEY/.test(pem)) {
      const encryptedInfo = forge.pki.encryptedPrivateKeyFromPem(pem);
      const privateKeyInfo = forge.pki.decryptPrivateKeyInfo(encryptedInfo, password);
      if (!privateKeyInfo) throw new Error('invalid password');
      return forge.pki.privateKeyFromAsn1(privateKeyInfo);
    }
    if (/BEGIN RSA PRIVATE KEY/.test(pem) && /ENCRYPTED/.test(pem)) {
      const key = forge.pki.decryptRsaPrivateKey(pem, password);
      if (!key) throw new Error('invalid password');
      return key;
    }
    return forge.pki.privateKeyFromPem(pem);
  } catch {
    throw new Error('The PEM private key or its password is invalid.');
  }
}

function parsePemCertificates(certificatePem) {
  const pem = String(certificatePem || '');
  if (pem.length > MAX_PEM_CHARACTERS) throw new Error('The PEM certificate bundle exceeds the 4 MB local signing limit.');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length) throw new Error('Choose a PEM X.509 certificate.');
  try {
    return blocks.map(block => forge.pki.certificateFromPem(block));
  } catch {
    throw new Error('The PEM certificate is invalid.');
  }
}

/**
 * Create a self-signed RSA-2048 signing certificate entirely in this process
 * and pack it as a password-protected PKCS#12 bundle. It proves document
 * integrity and binds the signer's name; readers only report it as trusted
 * once the user has marked the certificate as trusted themselves.
 */
export function createSelfSignedSigningCredential(options = {}) {
  const commonName = String(options.commonName || '').trim();
  if (!commonName) throw new Error('Enter the name that should appear in the certificate.');
  const password = String(options.password || '');
  if (password.length < 4) throw new Error('Choose a certificate password with at least 4 characters.');
  const email = String(options.email || '').trim();
  const organization = String(options.organization || '').trim();
  const validityYears = Math.min(10, Math.max(1, Math.round(Number(options.validityYears) || 3)));
  const bits = Math.max(2048, Number(options.bits) || 2048);
  const keys = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  const now = options.now instanceof Date ? options.now : new Date();
  certificate.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now.getTime());
  notAfter.setFullYear(notAfter.getFullYear() + validityYears);
  certificate.validity.notAfter = notAfter;
  const attributes = [{ name: 'commonName', value: commonName }];
  if (organization) attributes.push({ name: 'organizationName', value: organization });
  if (email) attributes.push({ name: 'emailAddress', value: email });
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  const extensions = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true, clientAuth: true },
    { name: 'subjectKeyIdentifier' },
  ];
  if (email) extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: email }] });
  certificate.setExtensions(extensions);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  // 3DES/SHA-1 PKCS#12 is what Acrobat, Windows and macOS Keychain import
  // without a "legacy" switch; the private key inside is still RSA-2048.
  const bundle = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], password, {
    algorithm: '3des',
    friendlyName: commonName,
    generateLocalKeyId: true,
  });
  const pkcs12 = binaryToBytes(forge.asn1.toDer(bundle).getBytes());
  const fingerprint = forge.md.sha256.create();
  fingerprint.update(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes());
  return {
    pkcs12,
    certificatePem: forge.pki.certificateToPem(certificate),
    commonName,
    email,
    notAfter,
    fingerprintSha256: fingerprint.digest().toHex().toUpperCase().match(/.{2}/g).join(':'),
    fileName: `${commonName.replace(/[^\w.-]+/g, '_') || 'certificate'}-fernwork.p12`,
  };
}

export function parsePdfSigningCredential(credential) {
  if (credential?.kind === 'pkcs12') {
    return parsePkcs12Credential(credential.data, credential.password || '');
  }
  if (credential?.kind === 'pem') {
    const privateKey = parsePrivateKeyPem(credential.privateKeyPem, credential.password || '');
    const certificates = parsePemCertificates(credential.certificatePem);
    return requireMatchingRsaCredential(privateKey, certificates);
  }
  throw new Error('Choose a PKCS#12/PFX bundle or a PEM key and certificate.');
}

function validateCredentialForSigning(credential, signingTime) {
  const bits = credential.privateKey?.n?.bitLength?.() || 0;
  if (bits < 2048) throw new Error(`The RSA private key is ${bits || 'an unknown number of'} bits; at least 2048 bits are required.`);
  try {
    const challenge = forge.random.getBytesSync(32);
    const challengeDigest = forge.md.sha256.create();
    challengeDigest.update(challenge, 'raw');
    const signature = credential.privateKey.sign(challengeDigest, 'RSASSA-PKCS1-V1_5');
    const verificationDigest = forge.md.sha256.create();
    verificationDigest.update(challenge, 'raw');
    if (!credential.certificate.publicKey.verify(
      verificationDigest.digest().getBytes(),
      signature,
      'RSASSA-PKCS1-V1_5',
    )) {
      throw new Error('invalid RSA key parameters');
    }
  } catch {
    throw new Error('The RSA private key is internally inconsistent or does not match the certificate.');
  }
  const { notBefore, notAfter } = credential.certificate.validity || {};
  if (notBefore && signingTime < notBefore) throw new Error('The signing certificate is not valid yet.');
  if (notAfter && signingTime > notAfter) throw new Error('The signing certificate has expired.');
  const keyUsage = credential.certificate.getExtension?.('keyUsage');
  if (keyUsage && !keyUsage.digitalSignature && !keyUsage.nonRepudiation) {
    throw new Error('The certificate key usage does not permit digital signatures.');
  }
}

function createDetachedCms(data, signingCredential, signingTime) {
  const signedData = forge.pkcs7.createSignedData();
  signedData.content = forge.util.createBuffer(bytesToBinary(data), 'raw');
  for (const certificate of signingCredential.certificates) signedData.addCertificate(certificate);
  signedData.addSigner({
    key: signingCredential.privateKey,
    certificate: signingCredential.certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime },
    ],
  });
  signedData.sign({ detached: true });
  return binaryToBytes(forge.asn1.toDer(signedData.toAsn1()).getBytes());
}

function sha256Binary(value) {
  const digest = forge.md.sha256.create();
  digest.update(typeof value === 'string' ? value : bytesToBinary(value), 'raw');
  return digest.digest().getBytes();
}

function binaryValuesEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function byteValuesEqual(left, right) {
  const a = asUint8Array(left);
  const b = asUint8Array(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function verifyDetachedCms(cmsBytes, detachedContent, certificate) {
  const contentInfo = forge.asn1.fromDer(bytesToBinary(cmsBytes), true);
  if (
    contentInfo.tagClass !== forge.asn1.Class.UNIVERSAL ||
    contentInfo.type !== forge.asn1.Type.SEQUENCE ||
    !contentInfo.constructed ||
    contentInfo.value.length !== 2 ||
    forge.asn1.derToOid(contentInfo.value[0].value) !== forge.pki.oids.signedData
  ) return false;

  const signedDataWrapper = contentInfo.value[1];
  const signedData = signedDataWrapper?.value?.[0];
  if (
    signedDataWrapper?.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC ||
    signedDataWrapper.type !== 0 ||
    !signedData ||
    signedData.type !== forge.asn1.Type.SEQUENCE
  ) return false;

  const encapsulatedContentInfo = signedData.value[2];
  if (
    encapsulatedContentInfo?.type !== forge.asn1.Type.SEQUENCE ||
    encapsulatedContentInfo.value?.length !== 1 ||
    forge.asn1.derToOid(encapsulatedContentInfo.value[0].value) !== forge.pki.oids.data
  ) return false;

  const signerInfos = signedData.value[signedData.value.length - 1];
  const signerInfo = signerInfos?.value?.[0];
  if (
    signerInfos?.type !== forge.asn1.Type.SET ||
    signerInfos.value.length !== 1 ||
    signerInfo?.type !== forge.asn1.Type.SEQUENCE ||
    signerInfo.value.length < 6
  ) return false;

  const digestAlgorithm = forge.asn1.derToOid(signerInfo.value[2]?.value?.[0]?.value || '');
  const signedAttributes = signerInfo.value[3];
  const signatureAlgorithm = forge.asn1.derToOid(signerInfo.value[4]?.value?.[0]?.value || '');
  const signature = signerInfo.value[5]?.value;
  if (
    digestAlgorithm !== forge.pki.oids.sha256 ||
    signedAttributes?.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC ||
    signedAttributes.type !== 0 ||
    ![
      forge.pki.oids.rsaEncryption,
      forge.pki.oids.sha256WithRSAEncryption,
      '1.2.840.113549.1.1.11',
    ].includes(signatureAlgorithm) ||
    typeof signature !== 'string'
  ) return false;

  let contentType = null;
  let messageDigest = null;
  for (const attribute of signedAttributes.value || []) {
    if (attribute?.type !== forge.asn1.Type.SEQUENCE || attribute.value?.length !== 2) return false;
    const attributeOid = forge.asn1.derToOid(attribute.value[0].value);
    const values = attribute.value[1];
    if (values?.type !== forge.asn1.Type.SET || values.value?.length !== 1) return false;
    if (attributeOid === forge.pki.oids.contentType) {
      contentType = forge.asn1.derToOid(values.value[0].value);
    } else if (attributeOid === forge.pki.oids.messageDigest) {
      messageDigest = values.value[0].value;
    }
  }
  if (
    contentType !== forge.pki.oids.data ||
    typeof messageDigest !== 'string' ||
    !binaryValuesEqual(messageDigest, sha256Binary(detachedContent))
  ) return false;

  const attributesSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    signedAttributes.value,
  );
  return certificate.publicKey.verify(
    sha256Binary(forge.asn1.toDer(attributesSet).getBytes()),
    signature,
    'RSASSA-PKCS1-V1_5',
  );
}

function verifyFinalPdfSignature(pdfBytes, byteRange, cmsBytes, certificate, placeholder) {
  const bytes = asUint8Array(pdfBytes);
  if (
    byteRange.length !== 4 ||
    !byteRange.every(Number.isSafeInteger) ||
    byteRange[0] !== 0 ||
    byteRange[1] <= 0 ||
    byteRange[2] <= byteRange[1] ||
    byteRange[3] < 0 ||
    byteRange[2] + byteRange[3] !== bytes.length ||
    byteRange[1] !== placeholder.contentsStart ||
    byteRange[2] !== placeholder.contentsEnd ||
    bytes[byteRange[1]] !== 0x3c ||
    bytes[byteRange[2] - 1] !== 0x3e
  ) return false;

  const serializedByteRange = new TextDecoder('ascii').decode(bytes.subarray(
    placeholder.byteRangeStart,
    placeholder.byteRangeStart + placeholder.byteRangeLength,
  ));
  const serializedMatch = serializedByteRange.match(
    /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]$/,
  );
  if (
    !serializedMatch ||
    serializedMatch.slice(1).some((value, index) => Number(value) !== byteRange[index])
  ) return false;

  const contentsHex = new TextDecoder('ascii').decode(bytes.subarray(byteRange[1] + 1, byteRange[2] - 1));
  const cmsHexLength = cmsBytes.length * 2;
  if (
    contentsHex.length < cmsHexLength ||
    !/^[0-9A-Fa-f]+$/.test(contentsHex) ||
    !/^0*$/.test(contentsHex.slice(cmsHexLength))
  ) return false;
  const embeddedCms = binaryToBytes(forge.util.hexToBytes(contentsHex.slice(0, cmsHexLength)));
  if (!byteValuesEqual(embeddedCms, cmsBytes)) return false;

  const detachedContent = concatenateBytes(
    bytes.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    bytes.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  );
  try {
    return verifyDetachedCms(embeddedCms, detachedContent, certificate);
  } catch {
    return false;
  }
}

function uniqueSignatureFieldName(acroForm, requestedName) {
  const existing = new Set();
  try {
    for (const [field] of acroForm.getAllFields()) {
      const name = field.getFullyQualifiedName?.();
      if (name) existing.add(name);
    }
  } catch {
    // A malformed legacy field tree must not prevent adding a uniquely named field.
  }
  const base = String(requestedName || 'FernworkSignature').trim() || 'FernworkSignature';
  if (!existing.has(base)) return base;
  let number = 2;
  while (existing.has(`${base}${number}`)) number += 1;
  return `${base}${number}`;
}

function appearanceSafeText(value) {
  return String(value || '').replace(/[^\x20-\x7e]/g, '?');
}

function normalizedPageRotation(page) {
  const angle = Math.round(Number(page?.getRotation?.()?.angle || 0));
  return ((angle % 360) + 360) % 360;
}

function signatureWidgetGeometry(page, options) {
  const pageSize = page.getSize();
  const rotation = normalizedPageRotation(page);
  const swapsAxes = rotation === 90 || rotation === 270;
  const displayWidth = swapsAxes ? pageSize.height : pageSize.width;
  const displayHeight = swapsAxes ? pageSize.width : pageSize.height;
  const logicalWidth = Math.min(displayWidth, Math.max(120, Number(options.widgetWidth) || 220));
  const logicalHeight = Math.min(displayHeight, Math.max(42, Number(options.widgetHeight) || 58));
  const requestedX = Number.isFinite(Number(options.widgetX)) ? Number(options.widgetX) : 36;
  const requestedY = Number.isFinite(Number(options.widgetY)) ? Number(options.widgetY) : 36;
  const displayX = Math.max(0, Math.min(requestedX, displayWidth - logicalWidth));
  const displayY = Math.max(0, Math.min(requestedY, displayHeight - logicalHeight));
  let rectangle;
  if (rotation === 90) {
    rectangle = [
      pageSize.width - displayY - logicalHeight,
      displayX,
      pageSize.width - displayY,
      displayX + logicalWidth,
    ];
  } else if (rotation === 180) {
    rectangle = [
      pageSize.width - displayX - logicalWidth,
      pageSize.height - displayY - logicalHeight,
      pageSize.width - displayX,
      pageSize.height - displayY,
    ];
  } else if (rotation === 270) {
    rectangle = [
      displayY,
      pageSize.height - displayX - logicalWidth,
      displayY + logicalHeight,
      pageSize.height - displayX,
    ];
  } else {
    rectangle = [displayX, displayY, displayX + logicalWidth, displayY + logicalHeight];
  }
  return {
    rectangle,
    rotation,
    logicalWidth,
    logicalHeight,
    appearanceWidth: swapsAxes ? logicalHeight : logicalWidth,
    appearanceHeight: swapsAxes ? logicalWidth : logicalHeight,
  };
}

function signatureAppearanceTextPoint(geometry, x, y) {
  const { rotation, logicalWidth: width, logicalHeight: height } = geometry;
  if (rotation === 90) return { x: height - y, y: x, rotation };
  if (rotation === 180) return { x: width - x, y: height - y, rotation };
  if (rotation === 270) return { x: y, y: width - x, rotation };
  return { x, y, rotation: 0 };
}

function createSignatureAppearance(pdfDocument, font, geometry, credential, signingTime, appearanceImage = null) {
  const context = pdfDocument.context;
  const fontKey = PDFName.of('Helv');
  const commonName = appearanceSafeText(certificateCommonName(credential.certificate)).slice(0, 52);
  const dateLabel = signingTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  if (appearanceImage) {
    // Handwritten/visual signature on top, certificate facts underneath.
    const padding = 8;
    const textBlock = 26;
    const areaWidth = Math.max(1, geometry.logicalWidth - padding * 2);
    const areaHeight = Math.max(1, geometry.logicalHeight - textBlock - padding);
    const scale = Math.min(areaWidth / appearanceImage.width, areaHeight / appearanceImage.height);
    const drawWidth = appearanceImage.width * scale;
    const drawHeight = appearanceImage.height * scale;
    const imagePoint = signatureAppearanceTextPoint(
      geometry,
      padding + (areaWidth - drawWidth) / 2,
      textBlock + (areaHeight - drawHeight) / 2,
    );
    const signerPoint = signatureAppearanceTextPoint(geometry, padding, 15);
    const datePoint = signatureAppearanceTextPoint(geometry, padding, 6);
    const operators = [
      ...drawRectangle({
        x: 0, y: 0, width: geometry.appearanceWidth, height: geometry.appearanceHeight,
        color: rgb(1, 1, 1), borderColor: rgb(0.09, 0.5, 0.24), borderWidth: 1,
        rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0),
      }),
      ...drawImage('SigImg', {
        x: imagePoint.x, y: imagePoint.y, width: drawWidth, height: drawHeight,
        rotate: degrees(imagePoint.rotation), xSkew: degrees(0), ySkew: degrees(0),
      }),
      ...drawText(font.encodeText(`Certificate signed by ${commonName} - trust not checked`), {
        color: rgb(0.08, 0.12, 0.1), font: fontKey, size: 6.5,
        rotate: degrees(signerPoint.rotation), xSkew: degrees(0), ySkew: degrees(0),
        x: signerPoint.x, y: signerPoint.y,
      }),
      ...drawText(font.encodeText(dateLabel), {
        color: rgb(0.28, 0.32, 0.3), font: fontKey, size: 6,
        rotate: degrees(datePoint.rotation), xSkew: degrees(0), ySkew: degrees(0),
        x: datePoint.x, y: datePoint.y,
      }),
    ];
    const appearance = context.formXObject(operators, {
      Resources: { Font: { Helv: font.ref }, XObject: { SigImg: appearanceImage.ref } },
      BBox: context.obj([0, 0, geometry.appearanceWidth, geometry.appearanceHeight]),
      Matrix: context.obj([1, 0, 0, 1, 0, 0]),
    });
    return context.register(appearance);
  }
  const titlePoint = signatureAppearanceTextPoint(geometry, 10, geometry.logicalHeight - 17);
  const signerPoint = signatureAppearanceTextPoint(geometry, 10, geometry.logicalHeight - 31);
  const datePoint = signatureAppearanceTextPoint(geometry, 10, 8);
  const operators = [
    ...drawRectangle({
      x: 0,
      y: 0,
      width: geometry.appearanceWidth,
      height: geometry.appearanceHeight,
      color: rgb(0.965, 0.98, 0.97),
      borderColor: rgb(0.09, 0.5, 0.24),
      borderWidth: 1,
      rotate: degrees(0),
      xSkew: degrees(0),
      ySkew: degrees(0),
    }),
    ...drawText(font.encodeText('Certificate signed - trust not checked'), {
      color: rgb(0.04, 0.3, 0.15),
      font: fontKey,
      size: 10,
      rotate: degrees(titlePoint.rotation),
      xSkew: degrees(0),
      ySkew: degrees(0),
      x: titlePoint.x,
      y: titlePoint.y,
    }),
    ...drawText(font.encodeText(`by ${commonName}`), {
      color: rgb(0.08, 0.12, 0.1),
      font: fontKey,
      size: 8,
      rotate: degrees(signerPoint.rotation),
      xSkew: degrees(0),
      ySkew: degrees(0),
      x: signerPoint.x,
      y: signerPoint.y,
    }),
    ...drawText(font.encodeText(dateLabel), {
      color: rgb(0.28, 0.32, 0.3),
      font: fontKey,
      size: 7,
      rotate: degrees(datePoint.rotation),
      xSkew: degrees(0),
      ySkew: degrees(0),
      x: datePoint.x,
      y: datePoint.y,
    }),
  ];
  const appearance = context.formXObject(operators, {
    Resources: { Font: { Helv: font.ref } },
    BBox: context.obj([0, 0, geometry.appearanceWidth, geometry.appearanceHeight]),
    Matrix: context.obj([1, 0, 0, 1, 0, 0]),
  });
  return context.register(appearance);
}

function addSignatureField(pdfDocument, credential, options, placeholderHex, appearanceFont, appearanceImage = null) {
  const pages = pdfDocument.getPages();
  if (!pages.length) throw new Error('The PDF contains no pages.');
  const pageIndex = Math.max(0, Math.min(pages.length - 1, Number(options.pageIndex) || 0));
  const page = pages[pageIndex];
  const context = pdfDocument.context;
  const acroForm = pdfDocument.catalog.getOrCreateAcroForm();
  const fieldName = uniqueSignatureFieldName(acroForm, options.fieldName);

  const byteRange = PDFArray.withContext(context);
  byteRange.push(PDFNumber.of(0));
  for (const sentinel of BYTE_RANGE_SENTINELS) byteRange.push(PDFNumber.of(sentinel));

  const signatureDictionary = PDFDict.withContext(context);
  signatureDictionary.set(PDFName.of('Type'), PDFName.of('Sig'));
  signatureDictionary.set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
  signatureDictionary.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
  signatureDictionary.set(PDFName.of('ByteRange'), byteRange);
  signatureDictionary.set(PDFName.of('Contents'), PDFHexString.of(placeholderHex));
  signatureDictionary.set(PDFName.of('M'), PDFString.of(pdfDate(options.signingTime)));
  signatureDictionary.set(PDFName.of('Name'), pdfText(certificateCommonName(credential.certificate)));
  if (options.reason?.trim()) signatureDictionary.set(PDFName.of('Reason'), pdfText(options.reason.trim()));
  if (options.location?.trim()) signatureDictionary.set(PDFName.of('Location'), pdfText(options.location.trim()));
  if (options.contactInfo?.trim()) signatureDictionary.set(PDFName.of('ContactInfo'), pdfText(options.contactInfo.trim()));
  const signatureRef = context.register(signatureDictionary);

  const geometry = signatureWidgetGeometry(page, options);
  const visible = options.visible !== false;
  const appearanceRef = createSignatureAppearance(
    pdfDocument,
    appearanceFont,
    geometry,
    credential,
    options.signingTime,
    appearanceImage,
  );

  const widget = PDFDict.withContext(context);
  widget.set(PDFName.of('Type'), PDFName.of('Annot'));
  widget.set(PDFName.of('Subtype'), PDFName.of('Widget'));
  widget.set(PDFName.of('FT'), PDFName.of('Sig'));
  widget.set(PDFName.of('T'), pdfText(fieldName));
  widget.set(PDFName.of('V'), signatureRef);
  widget.set(PDFName.of('Rect'), context.obj(visible ? geometry.rectangle : [0, 0, 0, 0]));
  widget.set(PDFName.of('F'), PDFNumber.of(4));
  widget.set(PDFName.of('P'), page.ref);
  const appearanceDictionary = PDFDict.withContext(context);
  appearanceDictionary.set(PDFName.of('N'), appearanceRef);
  widget.set(PDFName.of('AP'), appearanceDictionary);
  const widgetRef = context.register(widget);

  page.node.addAnnot(widgetRef);
  acroForm.addField(widgetRef);
  const existingFlags = acroForm.dict.lookupMaybe(PDFName.of('SigFlags'), PDFNumber)?.asNumber?.() || 0;
  acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(existingFlags | 3));
  return fieldName;
}

function findSignaturePlaceholders(bytes, placeholderHex) {
  const source = new TextDecoder('latin1').decode(bytes);
  const byteRangePattern = /\/ByteRange\s*\[\s*0\s+1111111111\s+2222222222\s+3333333333\s*\]/g;
  const ranges = [...source.matchAll(byteRangePattern)];
  if (ranges.length !== 1) throw new Error('Could not isolate the PDF signature ByteRange placeholder.');
  const contentsToken = `<${placeholderHex}>`;
  const contentsStart = source.indexOf(contentsToken);
  if (contentsStart < 0 || source.indexOf(contentsToken, contentsStart + 1) >= 0) {
    throw new Error('Could not isolate the PDF signature Contents placeholder.');
  }
  return {
    byteRangeStart: ranges[0].index,
    byteRangeLength: ranges[0][0].length,
    contentsStart,
    contentsEnd: contentsStart + contentsToken.length,
  };
}

function patchByteRange(bytes, placeholder, values) {
  const output = bytes.slice();
  let token = new TextDecoder('latin1').decode(output.subarray(
    placeholder.byteRangeStart,
    placeholder.byteRangeStart + placeholder.byteRangeLength,
  ));
  BYTE_RANGE_SENTINELS.forEach((sentinel, index) => {
    const replacement = String(values[index + 1]);
    if (replacement.length > String(sentinel).length) throw new Error('The PDF is too large for the signature ByteRange.');
    token = token.replace(String(sentinel), replacement.padEnd(String(sentinel).length, ' '));
  });
  output.set(new TextEncoder().encode(token), placeholder.byteRangeStart);
  return output;
}

function documentHasExistingSignature(pdfDocument) {
  for (const [, object] of pdfDocument.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const type = String(object.get(PDFName.of('Type')) || '');
    const fieldType = String(object.get(PDFName.of('FT')) || '');
    const subFilter = String(object.get(PDFName.of('SubFilter')) || '');
    const hasSignaturePayload = object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents'));
    if (
      hasSignaturePayload &&
      (type === '/Sig' || type === '/DocTimeStamp' || Boolean(subFilter))
    ) return true;
    if (fieldType === '/Sig' && object.has(PDFName.of('V'))) return true;
  }
  return false;
}

function serializedPdfObject(object) {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  return bytes;
}

function pdfObjectsEqual(left, right) {
  return byteValuesEqual(left, right);
}

function pdfObjectText(object) {
  return new TextDecoder('latin1').decode(serializedPdfObject(object));
}

function cmsDerBytes(contents) {
  const bytes = asUint8Array(contents);
  if (bytes.length < 2 || bytes[0] !== 0x30) throw new Error('The CMS signature container is malformed.');
  const marker = bytes[1];
  let headerLength = 2;
  let contentLength = marker;
  if (marker & 0x80) {
    const lengthBytes = marker & 0x7f;
    if (!lengthBytes || lengthBytes > 4 || bytes.length < 2 + lengthBytes) {
      throw new Error('The CMS signature container has an unsupported length.');
    }
    headerLength += lengthBytes;
    contentLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      contentLength = (contentLength * 256) + bytes[2 + index];
    }
  }
  const totalLength = headerLength + contentLength;
  if (totalLength > bytes.length) throw new Error('The CMS signature container is truncated.');
  return bytes.slice(0, totalLength);
}

function certificatesFromDetachedCms(cmsBytes) {
  const contentInfo = forge.asn1.fromDer(bytesToBinary(cmsBytes), true);
  const signedData = contentInfo?.value?.[1]?.value?.[0];
  if (!signedData?.value) return [];
  const certificates = signedData.value.find(item => (
    item?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && item.type === 0
  ));
  if (!certificates?.value) return [];
  return certificates.value.map(value => {
    try {
      return forge.pki.certificateFromAsn1(value);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function signatureFieldNames(pdfDocument) {
  const names = new Map();
  for (const [, object] of pdfDocument.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || String(object.get(PDFName.of('FT')) || '') !== '/Sig') continue;
    const value = object.get(PDFName.of('V'));
    if (!(value instanceof PDFRef)) continue;
    const title = object.get(PDFName.of('T'));
    let name = '';
    try {
      name = title?.decodeText?.() || String(title || '');
    } catch {
      name = '';
    }
    names.set(value.tag, name);
  }
  return names;
}

function exactContentsGapBytes(bytes, byteRange, contentsObject) {
  const gap = bytes.subarray(byteRange[1], byteRange[2]);
  if (gap.length < 2 || gap[0] !== 0x3c || gap[gap.length - 1] !== 0x3e) {
    throw new Error('The signature ByteRange gap is not one hexadecimal Contents token.');
  }
  const interior = new TextDecoder('latin1').decode(gap.subarray(1, -1));
  if (!/^[0-9A-Fa-f\x00\x09\x0A\x0C\x0D\x20]*$/u.test(interior)) {
    throw new Error('The signature ByteRange gap contains data outside its hexadecimal Contents token.');
  }
  const hex = interior.replace(/[\x00\x09\x0A\x0C\x0D\x20]/gu, '');
  const paddedHex = hex.length % 2 ? `${hex}0` : hex;
  const gapContents = binaryToBytes(forge.util.hexToBytes(paddedHex));
  const parsedContents = contentsObject.asBytes();
  if (!byteValuesEqual(gapContents, parsedContents)) {
    throw new Error('The signature ByteRange gap does not match the parsed Contents value.');
  }
  return gapContents;
}

function inspectParsedPdfSignatures(sourceBytes, pdfDocument) {
  const bytes = asUint8Array(sourceBytes);
  const fieldNames = signatureFieldNames(pdfDocument);
  const signatures = [];
  for (const [reference, object] of pdfDocument.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (!object.has(PDFName.of('ByteRange')) || !object.has(PDFName.of('Contents'))) continue;
    const type = String(object.get(PDFName.of('Type')) || '');
    const subFilter = String(object.get(PDFName.of('SubFilter')) || '');
    if (type !== '/Sig' && type !== '/DocTimeStamp' && !subFilter) continue;
    const result = {
      fieldName: fieldNames.get(reference.tag) || `Signature ${signatures.length + 1}`,
      commonName: 'Unknown signer',
      subFilter: subFilter.replace(/^\//, '') || 'unknown',
      integrity: 'invalid',
      coverage: 'unknown',
      trust: 'not-evaluated',
      revisionLength: 0,
      message: '',
    };
    try {
      const rangeObject = object.lookup(PDFName.of('ByteRange'));
      const contentsObject = object.lookup(PDFName.of('Contents'));
      const byteRange = Array.from({ length: rangeObject?.size?.() || 0 }, (_, index) => (
        rangeObject.lookup(index)?.asNumber?.()
      ));
      if (
        byteRange.length !== 4 ||
        !byteRange.every(Number.isSafeInteger) ||
        byteRange[0] !== 0 ||
        byteRange[1] <= 0 ||
        byteRange[2] <= byteRange[1] ||
        byteRange[3] < 0 ||
        byteRange[2] + byteRange[3] > bytes.length ||
        bytes[byteRange[1]] !== 0x3c ||
        bytes[byteRange[2] - 1] !== 0x3e
      ) throw new Error('The signature ByteRange is malformed or outside the PDF.');
      if (!contentsObject?.asBytes) throw new Error('The signature Contents value is malformed.');
      const cms = cmsDerBytes(exactContentsGapBytes(bytes, byteRange, contentsObject));
      const detachedContent = concatenateBytes(
        bytes.subarray(0, byteRange[1]),
        bytes.subarray(byteRange[2], byteRange[2] + byteRange[3]),
      );
      const certificates = certificatesFromDetachedCms(cms);
      const signingCertificate = certificates.find(certificate => {
        try {
          return verifyDetachedCms(cms, detachedContent, certificate);
        } catch {
          return false;
        }
      });
      if (!signingCertificate) throw new Error('The signed bytes do not match the embedded CMS signature.');
      result.commonName = certificateCommonName(signingCertificate);
      result.integrity = 'valid';
      result.revisionLength = byteRange[2] + byteRange[3];
      result.coverage = result.revisionLength === bytes.length ? 'entire-file' : 'signed-revision';
      result.message = result.coverage === 'entire-file'
        ? 'Integrity valid for the entire current file.'
        : `Integrity valid through signed revision byte ${result.revisionLength}.`;
    } catch (error) {
      result.message = error?.message || 'The signature could not be verified.';
    }
    signatures.push(result);
  }
  return {
    hasSignatures: signatures.length > 0,
    allIntegrityValid: signatures.length > 0 && signatures.every(signature => signature.integrity === 'valid'),
    signatures,
  };
}

export async function inspectPdfSignatures(pdfBytes) {
  const sourceBytes = asUint8Array(pdfBytes);
  if (!sourceBytes.length) return { hasSignatures: false, allIntegrityValid: false, signatures: [] };
  let pdfDocument;
  try {
    pdfDocument = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(error?.message || '')) throw new Error('Unlock the PDF before inspecting certificate signatures.');
    throw new Error(`The PDF signatures could not be inspected: ${error?.message || 'invalid PDF'}`);
  }
  return inspectParsedPdfSignatures(sourceBytes, pdfDocument);
}

function rejectUnsupportedSignedDocument(pdfDocument) {
  if (pdfDocument.context.trailerInfo?.Encrypt) {
    throw new Error('Unlock the PDF before applying a certificate signature.');
  }
  const perms = pdfDocument.catalog.get(PDFName.of('Perms'));
  if (perms) {
    throw new Error('This PDF is certified with document permissions. Fernwork will not add a signature because that could violate the certification policy.');
  }
  const hasRestrictedTransform = root => {
    const pending = [root];
    const visited = new Set();
    while (pending.length) {
      let object = pending.pop();
      if (object instanceof PDFRef) object = pdfDocument.context.lookup(object);
      if (!object || visited.has(object)) continue;
      visited.add(object);
      if (visited.size > 512) {
        throw new Error('The signature transform references are too complex to validate safely.');
      }
      if (object instanceof PDFDict) {
        let method = object.get(PDFName.of('TransformMethod'));
        if (method instanceof PDFRef) method = pdfDocument.context.lookup(method);
        if (['/DocMDP', '/FieldMDP'].includes(String(method || ''))) return true;
        for (const [, value] of object.entries()) pending.push(value);
      } else if (object instanceof PDFArray) {
        for (let index = 0; index < object.size(); index += 1) pending.push(object.get(index));
      }
    }
    return false;
  };
  for (const [, object] of pdfDocument.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const reference = object.get(PDFName.of('Reference'));
    if (!reference) continue;
    if (hasRestrictedTransform(reference)) {
      throw new Error('This PDF has DocMDP or FieldMDP signature restrictions. Fernwork will not add a signature that could violate them.');
    }
  }
}

function lastStartXrefOffset(bytes) {
  const source = new TextDecoder('latin1').decode(bytes);
  const matches = [...source.matchAll(/startxref\s+(\d+)\s+%%EOF/g)];
  if (!matches.length) throw new Error('The PDF has no readable startxref marker for an incremental update.');
  const offset = Number(matches.at(-1)[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error('The PDF startxref marker is malformed.');
  }
  return offset;
}

function indirectObjectBytes(reference, object) {
  return concatenateBytes(
    new TextEncoder().encode(`${reference.objectNumber} ${reference.generationNumber} obj\n`),
    serializedPdfObject(object),
    new TextEncoder().encode('\nendobj\n'),
  );
}

function incrementalTrailerText(pdfDocument, size, previousXref) {
  const trailer = pdfDocument.context.trailerInfo || {};
  if (!trailer.Root) throw new Error('The PDF trailer has no document catalog.');
  const entries = [`/Size ${size}`, `/Root ${trailer.Root}`];
  if (trailer.Info) entries.push(`/Info ${trailer.Info}`);
  if (trailer.ID) entries.push(`/ID ${pdfObjectText(trailer.ID)}`);
  entries.push(`/Prev ${previousXref}`);
  return `trailer\n<< ${entries.join(' ')} >>\n`;
}

function xrefSubsections(entries) {
  const sorted = [...entries].sort((left, right) => left.reference.objectNumber - right.reference.objectNumber);
  const groups = [];
  for (const entry of sorted) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || entry.reference.objectNumber !== previous.reference.objectNumber + 1) groups.push([entry]);
    else groups.at(-1).push(entry);
  }
  return groups.map(group => {
    const lines = group.map(entry => (
      `${String(entry.offset).padStart(10, '0')} ${String(entry.reference.generationNumber).padStart(5, '0')} n \n`
    )).join('');
    return `${group[0].reference.objectNumber} ${group.length}\n${lines}`;
  }).join('');
}

async function prepareIncrementalSignature(sourceBytes, pdfDocument, credential, fieldOptions, placeholderHex) {
  rejectUnsupportedSignedDocument(pdfDocument);
  const inspection = inspectParsedPdfSignatures(sourceBytes, pdfDocument);
  if (!inspection.hasSignatures) throw new Error('No existing PDF signature was found for incremental signing.');
  const invalid = inspection.signatures.find(signature => signature.integrity !== 'valid');
  if (invalid) {
    throw new Error(`Existing signature “${invalid.fieldName}” failed integrity verification: ${invalid.message}`);
  }

  const before = new Map(pdfDocument.context.enumerateIndirectObjects().map(([reference, object]) => (
    [reference.tag, serializedPdfObject(object)]
  )));
  const appearanceFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
  let appearanceImage = null;
  const imageDataUrl = String(fieldOptions.appearanceImageDataUrl || '');
  if (fieldOptions.visible !== false && /^data:image\/(png|jpeg|jpg);base64,/i.test(imageDataUrl)) {
    const imageBytes = binaryToBytes(atob(imageDataUrl.slice(imageDataUrl.indexOf(',') + 1)));
    appearanceImage = /^data:image\/png/i.test(imageDataUrl)
      ? await pdfDocument.embedPng(imageBytes)
      : await pdfDocument.embedJpg(imageBytes);
  }
  if (appearanceImage) {
    if (!Number.isFinite(Number(fieldOptions.widgetHeight))) fieldOptions.widgetHeight = 96;
    if (!Number.isFinite(Number(fieldOptions.widgetWidth))) fieldOptions.widgetWidth = 240;
  }
  const fieldName = addSignatureField(
    pdfDocument,
    credential,
    fieldOptions,
    placeholderHex,
    appearanceFont,
    appearanceImage,
  );
  const changed = pdfDocument.context.enumerateIndirectObjects().filter(([reference, object]) => {
    const previous = before.get(reference.tag);
    return !previous || !pdfObjectsEqual(previous, serializedPdfObject(object));
  });
  if (!changed.length) throw new Error('The incremental signature update produced no PDF objects.');

  const prefix = sourceBytes[sourceBytes.length - 1] === 0x0a || sourceBytes[sourceBytes.length - 1] === 0x0d
    ? new Uint8Array()
    : new TextEncoder().encode('\n');
  let cursor = sourceBytes.length + prefix.length;
  const objectParts = [];
  const xrefEntries = [];
  for (const [reference, object] of changed) {
    const serialized = indirectObjectBytes(reference, object);
    xrefEntries.push({ reference, offset: cursor });
    objectParts.push(serialized);
    cursor += serialized.length;
  }
  const xrefOffset = cursor;
  const largestObjectNumber = Math.max(
    pdfDocument.context.largestObjectNumber,
    ...changed.map(([reference]) => reference.objectNumber),
  );
  const xref = new TextEncoder().encode(
    `xref\n${xrefSubsections(xrefEntries)}${incrementalTrailerText(
      pdfDocument,
      largestObjectNumber + 1,
      lastStartXrefOffset(sourceBytes),
    )}startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return {
    prepared: concatenateBytes(sourceBytes, prefix, ...objectParts, xref),
    fieldName,
    previousSignatures: inspection.signatures,
  };
}

export async function signPdfWithCertificate(pdfBytes, credentialInput, options = {}) {
  const sourceBytes = asUint8Array(pdfBytes);
  if (!sourceBytes.length) throw new Error('There is no PDF to sign.');
  let pdfDocument;
  try {
    pdfDocument = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(error?.message || '')) throw new Error('Unlock the PDF before applying a certificate signature.');
    throw new Error(`The PDF could not be prepared for signing: ${error?.message || 'invalid PDF'}`);
  }
  const credential = parsePdfSigningCredential(credentialInput);
  const signingTime = options.signingTime instanceof Date ? options.signingTime : new Date(options.signingTime || Date.now());
  validateCredentialForSigning(credential, signingTime);
  const placeholderBytes = Math.max(8192, Number(options.placeholderBytes) || DEFAULT_SIGNATURE_PLACEHOLDER_BYTES);
  const placeholderHex = CONTENTS_SENTINEL.repeat(Math.ceil(placeholderBytes / 2)).slice(0, placeholderBytes * 2);

  const fieldOptions = { ...options, signingTime };
  let fieldName;
  let prepared;
  let previousSignatures = [];
  const incremental = documentHasExistingSignature(pdfDocument);
  if (incremental) {
    const result = await prepareIncrementalSignature(
      sourceBytes,
      pdfDocument,
      credential,
      fieldOptions,
      placeholderHex,
    );
    ({ prepared, fieldName, previousSignatures } = result);
  } else {
    const appearanceFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
    let appearanceImage = null;
    const imageDataUrl = String(options.appearanceImageDataUrl || '');
    if (options.visible !== false && /^data:image\/(png|jpeg|jpg);base64,/i.test(imageDataUrl)) {
      const imageBytes = binaryToBytes(atob(imageDataUrl.slice(imageDataUrl.indexOf(',') + 1)));
      appearanceImage = /^data:image\/png/i.test(imageDataUrl)
        ? await pdfDocument.embedPng(imageBytes)
        : await pdfDocument.embedJpg(imageBytes);
    }
    if (appearanceImage) {
      // A drawn signature needs more room than the three-line text stamp.
      if (!Number.isFinite(Number(options.widgetHeight))) fieldOptions.widgetHeight = 96;
      if (!Number.isFinite(Number(options.widgetWidth))) fieldOptions.widgetWidth = 240;
    }
    fieldName = addSignatureField(
      pdfDocument,
      credential,
      fieldOptions,
      placeholderHex,
      appearanceFont,
      appearanceImage,
    );
    prepared = asUint8Array(await pdfDocument.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    }));
  }
  const placeholder = findSignaturePlaceholders(prepared, placeholderHex);
  const byteRange = [
    0,
    placeholder.contentsStart,
    placeholder.contentsEnd,
    prepared.length - placeholder.contentsEnd,
  ];
  const rangedPdf = patchByteRange(prepared, placeholder, byteRange);
  const bytesToSign = concatenateBytes(
    rangedPdf.subarray(0, byteRange[1]),
    rangedPdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  );
  const cms = createDetachedCms(bytesToSign, credential, signingTime);
  if (cms.length > placeholderBytes) {
    throw new Error(`The certificate chain needs ${cms.length} signature bytes, exceeding the ${placeholderBytes}-byte reserve.`);
  }
  const cmsHex = [...cms].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  const paddedCmsHex = cmsHex.padEnd(placeholderBytes * 2, '0');
  rangedPdf.set(new TextEncoder().encode(paddedCmsHex), placeholder.contentsStart + 1);
  if (!verifyFinalPdfSignature(rangedPdf, byteRange, cms, credential.certificate, placeholder)) {
    throw new Error('The generated PDF signature failed internal verification. No file was exported.');
  }

  const certificate = credential.certificate;
  return {
    bytes: rangedPdf,
    fieldName,
    byteRange,
    cmsLength: cms.length,
    incremental,
    previousSignatures,
    certificate: {
      commonName: certificateCommonName(certificate),
      serialNumber: certificate.serialNumber || '',
      validFrom: certificate.validity?.notBefore?.toISOString?.() || '',
      validTo: certificate.validity?.notAfter?.toISOString?.() || '',
    },
  };
}

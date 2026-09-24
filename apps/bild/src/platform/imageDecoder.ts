/** @deprecated Use CodecHost from platform/hosts. Kept source-compatible for v1 embedders. */
import type { CodecHost } from './hosts/types';
export type { ExifOrientation, HostDecodedImage } from './hosts/types';
export type ImageDecoderHost = Omit<CodecHost, 'version'> & { readonly version?: CodecHost['version'] };

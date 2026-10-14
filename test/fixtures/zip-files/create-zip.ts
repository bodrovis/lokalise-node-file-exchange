import { deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
	name: string;
	data?: string | Buffer;
	compression?: "stored" | "deflate";
	/** UNIX mode includes file type bits: regular 0o100644, dir 0o040755, symlink 0o120777. */
	unixMode?: number;
	/** Override the declared uncompressed size to create deliberately malformed entries. */
	declaredSize?: number;
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Creates a small ZIP archive without additional runtime/test dependencies. */
export function createZip(entries: readonly ZipFixtureEntry[]): Buffer {
	if (entries.length > 65_535) {
		throw new Error("ZIP fixture exceeds the ZIP32 entry-count limit");
	}

	const localRecords: Buffer[] = [];
	const centralRecords: Buffer[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const content = Buffer.isBuffer(entry.data)
			? entry.data
			: Buffer.from(entry.data ?? "", "utf8");
		const isDeflate = entry.compression === "deflate";
		const encoded = isDeflate ? deflateRawSync(content) : content;
		const method = isDeflate ? 8 : 0;
		const size = entry.declaredSize ?? content.length;
		const checksum = crc32(content);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(encoded.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		localRecords.push(local, name, encoded);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(encoded.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(
			entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0,
			38,
		);
		central.writeUInt32LE(localOffset, 42);
		centralRecords.push(central, name);

		localOffset += local.length + name.length + encoded.length;
	}

	const centralDirectory = Buffer.concat(centralRecords);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);

	return Buffer.concat([...localRecords, centralDirectory, end]);
}

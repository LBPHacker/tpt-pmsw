"use strict";

document.addEventListener("DOMContentLoaded", () => {
	const pdb = document.querySelector("#pdb");
	const input = document.querySelector("#input");
	const output = document.querySelector("#output");

	const magic = new TextEncoder().encode("Microsoft C/C++ MSF 7.00\r\n\x1A\x44\x53\x00\x00\x00");
	const infoIndex = 1;
	const dbiIndex = 3;
	const expectSection = 1;

	const u8ArrayCompare = (lhs, rhs) => {
		if (lhs.length !== rhs.length) {
			return false;
		}
		for (let i = 0; i < lhs.length; ++i) {
			if (lhs[i] !== rhs[i]) {
				return false;
			}
		}
		return true;
	};

	const u16Le = (data, start) => {
		return  data[start    ]        |
		       (data[start + 1] <<  8);
	};

	const u32Le = (data, start) => {
		let value =  data[start    ]        |
		            (data[start + 1] <<  8) |
		            (data[start + 2] << 16) |
		            (data[start + 3] << 24);
		if (value < 0) {
			value += 0x100000000;
		}
		return value;
	};

	const s32Le = (data, start) => {
		let value = u32Le(data, start);
		if (value >= 0x80000000) {
			value -= 0x100000000;
		}
		return value;
	};

	const zstr = (data, start) => {
		let end = start;
		while (data[end]) {
			end += 1;
		}
		if (end >= data.length) {
			throw new BadPdbError("out of range zstr");
		}
		return data.subarray(start, end);
	};

	const asyncReplaceAll = async (str, regex, asyncFn) => {
		const promises = [];
		str.replaceAll(regex, (full, ...args) => {
			promises.push(asyncFn(full, ...args));
			return full;
		});
		const data = await Promise.all(promises);
		return str.replaceAll(regex, () => data.shift());
	};

	const nameHash = (data, mod) => {
		let value = 0;
		let i = 0;
		while (i < data.length - 3) {
			value ^= u32Le(data, i);
			i += 4;
		}
		if (data.length & 2) {
			value ^= u16Le(data, i);
			i += 2;
		}
		if (data.length & 1) {
			value ^= data[i];
			i += 1;
		}
		value |= 0x20202020;
		value ^= (value >> 11) & 0x1FFFFF;
		value ^= (value >> 16) & 0xFFFF;
		if (value < 0) {
			value += 0x100000000;
		}
		return value % mod;
	};

	class BadPdbError extends Error {
		constructor(message) {
			super(message);
			this.name = "BadPdbError";
		}
	}

	class BadCrashlogError extends Error {
		constructor(message) {
			super(message);
			this.name = "BadCrashlogError";
		}
	}

	const rehashCrashLog = async (file, crashLog) => {
		let bytesRead = 0;

		const [ getStreamData, getStreamSize ] = await (async () => {
			if (file.size < magic.length + 24) {
				throw new BadPdbError("truncated superblock");
			}
			if (!u8ArrayCompare(await file.slice(0, magic.length).bytes(), magic)) {
				throw new BadPdbError("bad magic");
			}

			const header = await file.slice(magic.length, magic.length + 24).bytes();
			const blockSize = u32Le(header, 0);
			const numBlocks = u32Le(header, 8);
			const numDirectoryBytes = u32Le(header, 12);
			const directoryAddr = u32Le(header, 20);
			if (blockSize % 4) {
				throw new BadPdbError("invalid block size");
			}
			if (numBlocks * blockSize < file.size) {
				throw new BadPdbError("invalid block count");
			}
			if (numDirectoryBytes % 4) {
				throw new BadPdbError("invalid directory byte count");
			}
			const getBlock = (index) => {
				if (index < 0 || index >= numBlocks) {
					throw new BadPdbError("block index out of range");
				}
				return file.slice(index * blockSize, (index + 1) * blockSize);
			};
			const numU32PerBlock = blockSize / 4;

			const gatherData = async (sourceBlockIndices, sourceSize, start, end) => {
				// assume(sourceSize <= sourceBlockIndices.length / 4 * blockSize)
				if (start < 0 || end < start || sourceSize < end) {
					throw new BadPdbError("invalid data range");
				}
				let blockIndexIndex = Math.floor(start / blockSize);
				let blockStart = start % blockSize;
				let dataStart = 0;
				let length = end - start;
				bytesRead += length;
				const data = new Uint8Array(length);
				while (length) {
					const blockLeft = blockSize - blockStart;
					const take = Math.min(blockLeft, length);
					const blockIndex = u32Le(sourceBlockIndices, blockIndexIndex * 4);
					data.set(await getBlock(blockIndex).slice(blockStart, blockStart + take).bytes(), dataStart);
					dataStart += take;
					length -= take;
					blockIndexIndex += 1;
					blockStart = 0;
				}
				return data;
			};

			const streamBlockInfo = await (async () => {
				const numDirectoryBlocks = Math.ceil(numDirectoryBytes / blockSize);
				if (numDirectoryBlocks > numU32PerBlock) {
					throw new BadPdbError("invalid directory block count");
				}
				const directoryIndices = await getBlock(directoryAddr).slice(0, 4 * numDirectoryBlocks).bytes();

				const streamBlockInfo = [];
				let directoryCursor = 0;
				const getDirectoryData = async (length) => {
					if (numDirectoryBytes < directoryCursor + length) {
						throw new BadPdbError("truncated directory");
					}
					const data = await gatherData(directoryIndices, numDirectoryBytes, directoryCursor, directoryCursor + length);
					directoryCursor += length;
					return data;
				};
				const numStreams = u32Le(await getDirectoryData(4), 0);
				let blockIndicesSizeSum = 0;
				const streamSizes = await getDirectoryData(numStreams * 4);
				for (let i = 0; i < numStreams; ++i) {
					const streamSize = u32Le(streamSizes, i * 4);
					const blockIndicesSize = Math.ceil(streamSize / blockSize);
					blockIndicesSizeSum += blockIndicesSize;
				}
				const streamBlockIndices = await getDirectoryData(blockIndicesSizeSum * 4);
				let cursor = 0;
				for (let i = 0; i < numStreams; ++i) {
					const streamSize = u32Le(streamSizes, i * 4);
					const blockIndicesSize = Math.ceil(streamSize / blockSize);
					streamBlockInfo.push({
						"blockIndices": streamBlockIndices.subarray(cursor * 4, (cursor + blockIndicesSize) * 4),
						"size": streamSize,
					});
					cursor += blockIndicesSize;
				}
				return streamBlockInfo;
			})();

			const getStreamData = async (index, start, end) => {
				if (index < 0 || index >= streamBlockInfo.length) {
					throw new BadPdbError("stream index out of range");
				}
				return await gatherData(streamBlockInfo[index].blockIndices, streamBlockInfo[index].size, start, end);
			};

			const getStreamSize = (index) => {
				if (index < 0 || index >= streamBlockInfo.length) {
					throw new BadPdbError("stream index out of range");
				}
				return streamBlockInfo[index].size;
			};

			return [ getStreamData, getStreamSize ];
		})();

		const getStreamU32LeString = async (index, cursor) => {
			const stringSize = u32Le(await getStreamData(index, cursor, cursor + 4), 0);
			cursor += 4;
			const string = await getStreamData(index, cursor, cursor + stringSize);
			cursor += stringSize;
			return [ string, cursor ];
		};

		const getStreamHashTable = async (index, cursor, valueSize) => {
			const header = await getStreamData(index, cursor, cursor + 12);
			const size = u32Le(header, 0);
			const presentWords = u32Le(header, 8);
			cursor += 12;
			const present = await getStreamData(index, cursor, cursor + presentWords * 4 + 4);
			cursor += presentWords * 4 + 4;
			const deletedWords = u32Le(present, presentWords * 4);
			const deleted = await getStreamData(index, cursor, cursor + deletedWords * 4);
			cursor += deletedWords * 4;
			const kvpairs = await getStreamData(index, cursor, cursor + size * (valueSize + 4));
			cursor += size * (valueSize + 4);
			const ht = new Map();
			for (let i = 0; i < size; ++i) {
				ht.set(u32Le(kvpairs, (valueSize + 4) * i), kvpairs.subarray((valueSize + 4) * i + 4, (valueSize + 4) * (i + 1)));
			}
			return [ ht, cursor ];
		};

		const [ pdbsNames, minimalDebugInfo ] = await (async () => {
			const pdbsNames = new Map();
			let minimalDebugInfo = false;
			const pdbsHeader = await getStreamData(infoIndex, 0, 12);
			if (u32Le(pdbsHeader, 0) !== 20000404) {
				throw new BadPdbError("unsupported PDBS version");
			}
			const [ pdbsStrings, pdbsCursor ] = await getStreamU32LeString(infoIndex, 28);
			const [ pdbsNameIndices, pdbsCursor2 ] = await getStreamHashTable(infoIndex, pdbsCursor, 4);
			const td = new TextDecoder();
			for (const [ key, value ] of pdbsNameIndices) {
				pdbsNames.set(td.decode(zstr(pdbsStrings, key)), u32Le(value, 0));
			}
			const streamSize = getStreamSize(infoIndex);
			const features = await getStreamData(infoIndex, pdbsCursor2 + 4 /* skip niMac */, streamSize);
			if (features.length % 4) {
				throw new BadPdbError("unsupported PDBS features size");
			}
			for (let i = 0; i < features.length; i += 4) {
				const feature = u32Le(features, i);
				if (feature === 0x494E494D) {
					minimalDebugInfo = true;
				}
			}
			return [ pdbsNames, minimalDebugInfo ];
		})();

		const getName = await (async () => {
			const namesIndex = pdbsNames.get("/names");
			if (!namesIndex) {
				throw new BadPdbError("missing /names steam");
			}
			const namesData = await getStreamData(namesIndex, 0, getStreamSize(namesIndex));
			const td = new TextDecoder();
			const getName = (offset) => {
				return td.decode(zstr(namesData, offset + 12));
			};
			return getName;
		})();

		const getGetEnclosingFragment = (fragments, deduplicate) => {
			fragments.sort((lhs, rhs) => {
				return lhs.offset - rhs.offset;
			});
			if (deduplicate) {
				const deduplicated = []
				let lastOffset;
				let lastSize;
				for (const fragment of fragments) {
					if (!(lastOffset === fragment.offset && lastSize === fragment.size)) {
						deduplicated.push(fragment);
						lastOffset = fragment.offset;
						lastSize = fragment.size;
					}
				}
				fragments = deduplicated;
			}
			{
				let lastSeen = 0;
				for (const fragment of fragments) {
					if (fragment.offset < lastSeen) {
						throw new BadPdbError("overlapping fragments");
					}
					lastSeen = fragment.offset + fragment.size;
				}
			}

			const getEnclosingFragment = (addr) => {
				let start = 0;
				let end = fragments.length;
				while (start + 1 < end) {
					const mid = Math.floor((start + end) / 2);
					if (fragments[mid].offset <= addr) {
						start = mid;
					} else {
						end = mid;
					}
				}
				if (start === end || addr >= fragments[start].offset + fragments[start].size) {
					return;
				}
				return fragments[start];
			};

			return getEnclosingFragment;
		};

		const [ globalIndex, publicIndex, symrecIndex, modInfoByFileIndex, getModIndexFromAddr ] = await (async () => {
			let cursor = 0;
			const dbiHeader = await getStreamData(dbiIndex, cursor, cursor + 64);
			cursor += 64;
			if (u32Le(dbiHeader, 4) !== 19990903 ||
			    !(u16Le(dbiHeader, 14) & 0x8000)) {
				throw new BadPdbError("unsupported DBI version");
			}
			const globalIndex = u16Le(dbiHeader, 12);
			const publicIndex = u16Le(dbiHeader, 16);
			const symrecIndex = u16Le(dbiHeader, 20);

			const modInfoSize = s32Le(dbiHeader, 24);
			if (modInfoSize < 0) {
				throw new BadPdbError("invalid DBI mod info size");
			}
			const secContribSize = s32Le(dbiHeader, 28);
			if (secContribSize < 0) {
				throw new BadPdbError("invalid DBI sec contrib size");
			}

			const modSecContribData = await getStreamData(dbiIndex, cursor, cursor + modInfoSize + secContribSize);
			const modData = modSecContribData.subarray(0, modInfoSize);
			const secContribData = modSecContribData.subarray(modInfoSize, modInfoSize + secContribSize);
			cursor += modInfoSize + secContribSize;
			const modInfoByFileIndex = [];
			let modInfoCursor = 0;
			while (modInfoCursor < modInfoSize) {
				if (modInfoCursor + 64 > modInfoSize) {
					throw new BadPdbError("truncated mod info structure");
				}
				const moduleSymStream = u16Le(modData, modInfoCursor + 34);
				const symByteSize = u32Le(modData, modInfoCursor + 36);
				const c11ByteSize = u32Le(modData, modInfoCursor + 40);
				if (c11ByteSize) {
					throw new BadPdbError("unsupported mod info structure with C11 line info");
				}
				const c13ByteSize = u32Le(modData, modInfoCursor + 44);
				const thisModInfo = {
					"streamIndex": moduleSymStream !== 0xFFFF ? moduleSymStream : -1,
					"symByteSize": symByteSize,
					"c13ByteSize": c13ByteSize,
				};
				modInfoByFileIndex.push(thisModInfo);
				modInfoCursor += 64;
				const moduleName = zstr(modData, modInfoCursor);
				modInfoCursor += moduleName.length + 1;
				const objFileName = zstr(modData, modInfoCursor);
				modInfoCursor += objFileName.length + 1;
				modInfoCursor = Math.ceil(modInfoCursor / 4) * 4;
			}

			const modInfoSorted = [];
			let secContribCursor = 0;
			if (u32Le(secContribData, 0) !== 4046371373) {
				throw new BadPdbError("unsupported DBI sec contrib version");
			}
			secContribCursor += 4;
			while (secContribCursor < secContribSize) {
				if (secContribCursor + 28 > secContribSize) {
					throw new BadPdbError("truncated sec contrib structure");
				}
				const section = u16Le(secContribData, secContribCursor);
				if (section === expectSection) {
					const offset = s32Le(secContribData, secContribCursor + 4);
					if (offset < 0) {
						throw new BadPdbError("invalid section offset");
					}
					const size = s32Le(secContribData, secContribCursor + 8);
					if (size < 0) {
						throw new BadPdbError("invalid section size");
					}
					const moduleIndex = u16Le(secContribData, secContribCursor + 16);
					modInfoSorted.push({
						"offset": offset,
						"size": size,
						"moduleIndex": moduleIndex,
					});
				}
				secContribCursor += 28;
			}

			modInfoSorted.sort((lhs, rhs) => {
				return lhs.offset - rhs.offset;
			});
			let lastSeen = 0;
			for (const modInfo of modInfoSorted) {
				if (modInfo.offset < lastSeen) {
					throw new BadPdbError("overlapping sections");
				}
				lastSeen = modInfo.offset + modInfo.size;
			}

			const getModIndexFromAddr = (() => {
				const getEnclosingFragment = getGetEnclosingFragment(modInfoSorted, false);
				const getModIndexFromAddr = (addr) => {
					const modInfo = getEnclosingFragment(addr);
					if (modInfo) {
						return modInfo.moduleIndex;
					}
				};
				return getModIndexFromAddr;
			})();

			return [ globalIndex, publicIndex, symrecIndex, modInfoByFileIndex, getModIndexFromAddr ];
		})();

		const getGetFunctionInfo = async (streamIndex, isPsi) => {
			let cursor = 0;
			let gsiSize = getStreamSize(streamIndex);
			if (isPsi) {
				const psiHeader = await getStreamData(streamIndex, cursor, cursor + 28);
				cursor += 28;
				gsiSize = u32Le(psiHeader, 0);
			}
			const gsiHeader = await getStreamData(streamIndex, cursor, cursor + 16);
			cursor += 16;
			const headersSize = cursor;
			if (u32Le(gsiHeader, 0) !== 0xFFFFFFFF ||
			    u32Le(gsiHeader, 4) !== 4046391578) {
				throw new BadPdbError("unsupported GSI version");
			}
			const numHrfileBytes = s32Le(gsiHeader, 8);
			const numBucketBytes = s32Le(gsiHeader, 12);
			if (numHrfileBytes < 0 || numHrfileBytes % 8) {
				throw new BadPdbError("invalid GSI hrfile byte count");
			}
			if (numBucketBytes < 0) {
				throw new BadPdbError("invalid GSI bucket byte count");
			}
			if (gsiSize !== 16 + numHrfileBytes + numBucketBytes) {
				throw new BadPdbError("truncated GSI");
			}
			const hrfiles = await getStreamData(streamIndex, cursor, cursor + numHrfileBytes);
			cursor += numHrfileBytes;
			const bucketWords = [];
			let numHrfiles = 0;
			const numBuckets = minimalDebugInfo ? 0x40000 : 4097;
			if (numBucketBytes) {
				numHrfiles = numHrfileBytes / 8;
				const numPresentWords = Math.ceil(numBuckets / 32);
				const presentWords = await getStreamData(streamIndex, cursor, cursor + numPresentWords * 4);
				const present = (index) => {
					return (presentWords[Math.floor(index / 8)] >> (index % 8)) & 1;
				};
				cursor += numPresentWords * 4;
				let numPackedBucketWords = 0;
				for (let i = 0; i < numBuckets; ++i) {
					if (present(i)) {
						numPackedBucketWords += 1;
					}
				}
				const packedBucketWords = await getStreamData(streamIndex, cursor, cursor + numPackedBucketWords * 4);
				cursor += numPackedBucketWords * 4;
				if (cursor !== headersSize + numHrfileBytes + numBucketBytes) {
					throw new BadPdbError("invalid GSI bucket data");
				}
				let hrfilesCursor = numHrfiles;
				let bucketDataCursor = packedBucketWords.length;
				for (let i = numBuckets - 1; i >= 0; --i) {
					let hrfilesOffset = -1;
					if (present(i)) {
						bucketDataCursor -= 4;
						hrfilesOffset = u32Le(packedBucketWords, bucketDataCursor);
					}
					const offsets = [];
					if (hrfilesOffset !== -1) {
						if (hrfilesOffset % 12 || hrfilesOffset / 12 * 8 >= numHrfileBytes) {
							throw new BadPdbError("invalid GSI hrfile offset");
						}
						while (hrfilesCursor > hrfilesOffset / 12) {
							hrfilesCursor -= 1;
							offsets.push(u32Le(hrfiles, hrfilesCursor * 8) - 1);
						}
					}
					bucketWords.push(offsets);
				}
				if (bucketDataCursor !== 0) {
					throw new BadPdbError("invalid GSI ht");
				}
				if (hrfilesCursor !== 0) {
					throw new BadPdbError("invalid GSI hrfile data");
				}
			}
			bucketWords.reverse();

			const getSymbolData = async (streamIndex, start) => {
				const length = u16Le(await getStreamData(streamIndex, start, start + 2), 0);
				const data = await getStreamData(streamIndex, start, start + 2 + length);
				return [ u16Le(data, 2), data ];
			};

			const getFunctionAddress = async (name) => {
				const nameData = new TextEncoder().encode(name);
				for (const psymOffset of bucketWords[nameHash(nameData, bucketWords.length - 1)]) {
					const [ refKind, refData ] = await getSymbolData(symrecIndex, psymOffset);
					if (refKind == 0x1125 && u8ArrayCompare(zstr(refData, 14), nameData)) {
						const symStart = u32Le(refData, 8);
						const modIndex = u16Le(refData, 12) - 1;
						const [ symKind, symData ] = await getSymbolData(modInfoByFileIndex[modIndex].streamIndex, symStart);
						if (symKind == 0x1110 && u16Le(symData, 36) === expectSection) {
							return u32Le(symData, 32);
						}
					}
				}
			};

			return getFunctionAddress;
		};
		const getGlobalFunctionInfo = await getGetFunctionInfo(globalIndex, false);

		const getModiData = (() => {
			const modiDataCache = new Map();
			const getModiData = async (modIndex) => {
				if (modIndex < 0 || modIndex >= modInfoByFileIndex.length) {
					throw new BadPdbError("module index out of range");
				}
				if (modiDataCache.get(modIndex) === undefined) {
					const streamIndex = modInfoByFileIndex[modIndex].streamIndex;
					if (streamIndex !== -1) {
						const symByteSize = modInfoByFileIndex[modIndex].symByteSize;
						const c13ByteSize = modInfoByFileIndex[modIndex].c13ByteSize;
						const c13Data = await getStreamData(streamIndex, symByteSize, symByteSize + c13ByteSize);
						let c13Cursor = 0;
						const lineFragments = [];
						let checksumData;
						while (c13Cursor < c13ByteSize) {
							if (c13Cursor + 8 > c13ByteSize) {
								throw new BadPdbError("truncated c13 structure");
							}
							const kind = u32Le(c13Data, c13Cursor);
							const length = u32Le(c13Data, c13Cursor + 4);
							c13Cursor += 8;
							if (kind == 0xF2) {
								const offset = u32Le(c13Data, c13Cursor);
								const segment = u16Le(c13Data, c13Cursor + 4);
								const flags = u16Le(c13Data, c13Cursor + 6);
								const size = u32Le(c13Data, c13Cursor + 8);
								let headerCursor = c13Cursor + 12;
								const nameIndex = u32Le(c13Data, headerCursor);
								const numLines = u32Le(c13Data, headerCursor + 4);
								const blockSize = u32Le(c13Data, headerCursor + 8);
								headerCursor += 12;
								const lines = [];
								for (let i = 0; i < numLines; ++i) {
									const lineOffset = u32Le(c13Data, headerCursor);
									const data = u32Le(c13Data, headerCursor + 4);
									headerCursor += 8;
									const startLine = data & 0xFFFFFF;
									const delta = (data >> 24) & 0x7F;
									lines.push({
										"start": startLine,
										"end": startLine + delta + 1,
										"offset": offset + lineOffset,
									});
								}
								if (lines.length) {
									for (let i = 0; i < lines.length - 1; ++i) {
										lines[i].size = lines[i + 1].offset - lines[i].offset;
									}
									lines[lines.length - 1].size = offset + size - lines[lines.length - 1].offset;
								}
								if (flags & 1) {
									headerCursor += numLines * 4;
								}
								if (headerCursor !== c13Cursor + 12 + blockSize) {
									throw new BadPdbError("invalid c13 structure");
								}
								if (segment === expectSection) {
									lineFragments.push({
										"offset": offset,
										"size": size,
										"nameIndex": nameIndex,
										"getSublineFromAddr": getGetEnclosingFragment(lines),
									});
								}
							} else if (kind == 0xF4) {
								checksumData = c13Data.subarray(c13Cursor, c13Cursor + length);
							}
							if (c13Cursor + length > c13ByteSize) {
								throw new BadPdbError("truncated c13 structure");
							}
							c13Cursor += length;
						}
						if (!checksumData) {
							throw new BadPdbError("no c13 checksum data");
						}
						for (const lineFragment of lineFragments) {
							if (lineFragment.nameIndex + 6 >= checksumData.length) {
								throw new BadPdbError("out of range c13 name index");
							}
							lineFragment.stringTableOffset = u32Le(checksumData, lineFragment.nameIndex);
						}
						modiDataCache.set(modIndex, {
							"getLineFromAddr": getGetEnclosingFragment(lineFragments, true),
						});
					} else {
						modiDataCache.set(modIndex, {
							"getLineFromAddr": null,
						});
					}
				}
				return modiDataCache.get(modIndex);
			};
			return getModiData;
		})();

		const getIaFileLine = async	(ia) => {
			const modIndex = getModIndexFromAddr(ia);
			if (!modIndex) {
				return;
			}
			const modiData = await getModiData(modIndex);
			if (!modiData.getLineFromAddr) {
				return;
			}
			const lineFragment = modiData.getLineFromAddr(ia);
			if (!lineFragment) {
				return;
			}
			const subline = lineFragment.getSublineFromAddr(ia);
			if (!subline) {
				return;
			}
			return getName(lineFragment.stringTableOffset) + ":" + subline.start;
		};

		let mainIa;
		let mainVa;
		const mainStr = crashLog.match(/Main is at (0x[^\n:]+):/);
		if (mainStr) {
			mainVa = parseInt(mainStr[1]);
			mainIa = await getGlobalFunctionInfo("Main");
		}
		if (!mainVa) {
			const pstOffsets = new Map();
			pstOffsets.set("98.2.365 X86_64-WINDOWS-MSVC LUACONSOLE HTTPS@e371d63", 0x146);
			const topFrame = crashLog.match(/\[(0x[^\n\]]+)\]/);
			const versionMatch = crashLog.match(/Version: ([^\n]+)/);
			const tagMatch = crashLog.match(/Tag: ([^\n]+)/);
			if (topFrame && versionMatch && tagMatch) {
				const pstOffset = pstOffsets.get(versionMatch[1] + "@" + tagMatch[1]);
				if (pstOffset) {
					mainVa = parseInt(topFrame[1]) - pstOffset;
					mainIa = await getGlobalFunctionInfo("Platform::StackTrace");
				}
			}
		}
		if (!mainVa) {
			throw new BadCrashlogError("Main VA not specified");
		}
		const iaToVa = mainVa - mainIa;

		const annotatedCrashLog = await asyncReplaceAll(crashLog, /-[^\n\[]+\[0x[^\n\]]+\]/g, async (match) => {
			const vaTag = match.match(/\[0x[^\n\]]+\]/)[0];
			const vaStr = vaTag.substring(1, vaTag.length - 1);
			const va = parseInt(vaStr);
			const ia = va - iaToVa;
			const fileLine = await getIaFileLine(ia);
			if (fileLine) {
				return "@ " + fileLine + " " + vaTag;
			}
			return match;
		});

		// console.log(bytesRead + " bytes of stream data read");
		return annotatedCrashLog;
	};

	const update = async () => {
		if (!input.value) {
			output.value = "(no crash log)";
		} else if (pdb.files.length) {
			try {
				output.value = await rehashCrashLog(pdb.files[0], input.value);
			} catch (err) {
				if (err instanceof BadPdbError ||
				    err instanceof BadCrashlogError) {
					output.value = "(" + err.message + "; check console for stack trace)";
					console.log(err);
				} else {
					output.value = "(internal error; check console for stack trace)";
					throw err;
				}
			}
		} else {
			output.value = "(no pdb)";
		}
	};

	pdb.addEventListener("change", update);
	input.addEventListener("change", update);
	input.addEventListener("input", update);

	update();
});

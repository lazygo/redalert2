import { DataStream } from "./DataStream";
import { VirtualFile } from "./vfs/VirtualFile";
import type { IdxFile } from "./IdxFile";
import type { IdxEntry } from "./IdxEntry";

/**
 * audio.bag archive. Entries are resolved by idx offset into the shared bag
 * buffer; WAV headers are built lazily on first open instead of copying every
 * sample up-front.
 */
export class AudioBagFile {
    private bagBuffer?: ArrayBuffer;
    private bagByteOffset = 0;
    private readonly entries = new Map<string, IdxEntry>();
    /** Lazily materialized full WAV streams (header + sample bytes). */
    private readonly materialized = new Map<string, DataStream>();

    public async fromVirtualFile(bagFile: VirtualFile, idx: IdxFile): Promise<this> {
        this.bagBuffer = bagFile.stream.buffer;
        this.bagByteOffset = bagFile.stream.byteOffset;
        this.entries.clear();
        this.materialized.clear();
        for (const [filename, entry] of idx.entries) {
            this.entries.set(filename, entry);
        }
        return this;
    }

    public getFileList(): string[] {
        return [...this.entries.keys()];
    }

    public containsFile(filename: string): boolean {
        return this.entries.has(filename);
    }

    public openFile(filename: string): VirtualFile {
        if (!this.containsFile(filename)) {
            throw new Error(`File "${filename}" not found in AudioBagFile`);
        }
        let dataStream = this.materialized.get(filename);
        if (!dataStream) {
            dataStream = this.buildWavData(this.entries.get(filename)!);
            dataStream.dynamicSize = false;
            this.materialized.set(filename, dataStream);
        }
        dataStream.seek(0);
        return new VirtualFile(dataStream, filename);
    }

    private buildWavData(idxEntry: IdxEntry): DataStream {
        if (!this.bagBuffer) {
            throw new Error("AudioBagFile: bag buffer not loaded");
        }
        const outStream = new DataStream();
        outStream.littleEndian();
        const channels = (idxEntry.flags & 0x01) > 0 ? 2 : 1;
        let paddingBytes = 0;
        if ((idxEntry.flags & 0x02) > 0) {
            outStream.writeString("RIFF");
            outStream.writeUint32(idxEntry.length + 36);
            outStream.writeString("WAVE");
            outStream.writeString("fmt ");
            outStream.writeUint32(16);
            outStream.writeUint16(1);
            outStream.writeUint16(channels);
            outStream.writeUint32(idxEntry.sampleRate);
            outStream.writeUint32(idxEntry.sampleRate * channels * 2);
            outStream.writeUint16(channels * 2);
            outStream.writeUint16(16);
            outStream.writeString("data");
            outStream.writeUint32(idxEntry.length);
        }
        else if ((idxEntry.flags & 0x08) > 0) {
            const byteRate = 11100 * channels * Math.floor(idxEntry.sampleRate / 22050);
            const blockAlign = idxEntry.chunkSize;
            const samplesPerBlock = 1017;
            const numBlocks = Math.max(2, Math.ceil(idxEntry.length / blockAlign));
            const totalDataBytesInAdpcm = numBlocks * blockAlign;
            paddingBytes = totalDataBytesInAdpcm - idxEntry.length;
            outStream.writeString("RIFF");
            outStream.writeUint32(52 + totalDataBytesInAdpcm);
            outStream.writeString("WAVE");
            outStream.writeString("fmt ");
            outStream.writeUint32(20);
            outStream.writeUint16(17);
            outStream.writeUint16(channels);
            outStream.writeUint32(idxEntry.sampleRate);
            outStream.writeUint32(byteRate);
            outStream.writeUint16(blockAlign);
            outStream.writeUint16(4);
            outStream.writeUint16(2);
            outStream.writeUint16(samplesPerBlock);
            outStream.writeString("fact");
            outStream.writeUint32(4);
            outStream.writeUint32(samplesPerBlock * numBlocks);
            outStream.writeString("data");
            outStream.writeUint32(totalDataBytesInAdpcm);
        }
        else {
            console.warn(`AudioBagFile: Unknown flags ${idxEntry.flags} for WAV header generation for entry referencing offset ${idxEntry.offset}.`);
        }
        // View into the shared bag — only copied into the WAV stream when this entry is first opened.
        const audioData = new Uint8Array(
            this.bagBuffer,
            this.bagByteOffset + idxEntry.offset,
            idxEntry.length,
        );
        outStream.writeUint8Array(audioData);
        for (let i = 0; i < paddingBytes; i++) {
            outStream.writeUint8(0);
        }
        outStream.seek(0);
        return outStream;
    }
}

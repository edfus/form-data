import { ok as assert } from "assert";
import { Readable } from "stream";
import { randomBytes } from "crypto";

const kOnceResume = Symbol("onceResume");
const kReading = Symbol("reading");
const kReadNext = Symbol("readNext");
const kChunkBuffer = Symbol("chunkBuffer");

class FormDataStream extends Readable {
  lineBreak = "\r\n";
  defaultContentType = "text/plain";
  defaultStreamContentType = "application/octet-stream";
  [kChunkBuffer] = "";

  constructor(iterator) {
    super();
    this.iterator = iterator;
    this.boundary = this.generateBoundary();
  }

  async readNext () {
    this[kReading] = true;
    const boundary = this.boundary;
    const { done, value } = this.iterator.next();
    
    if(done) {
      this.push(`--${boundary}--`);
      this[kReading] = false;
      return this.push(null);
    }

    const [name, content] = value;
    
    this.pushChunk(`--${boundary}`);
    this.pushChunk(this.lineBreak);

    this.pushChunk(`Content-Disposition: form-data; name="${encodeURIComponent(name)}"`);
    // Readable or { source, filename, contentType, contentTransferEncoding }
    if(content instanceof Readable || content.source) {
      const source = content.source || content;
      const filename = content.filename || basename(content.path || "") || name;
      
      this.pushChunk(`; filename="${encodeURIComponent(filename)}"`);
      this.pushChunk(this.lineBreak);

      await this.streamFileField(source, content.contentType);
    } else {
      this.pushChunk(this.lineBreak);
      // Array
      if(Array.isArray(content)) {
        let filenameIndex = 0;
        const subBoundary = this.generateBoundary();
        this.pushChunk(`Content-Type: multipart/mixed; boundary=${subBoundary}`);
        this.pushChunk(this.lineBreak.repeat(2));

        /**
         * source: string | Buffer | Readable,
         * filename: string,
         * contentType: string,
         * contentTransferEncoding: string
         */
        for (const file of content) {
          this.pushChunk(`--${subBoundary}`);
          this.pushChunk(this.lineBreak);

          if(file instanceof Readable) {
            const filename = basename(file.path || "") || `${name}-${filenameIndex++}`;
            this.pushChunk(
              `Content-Disposition: file; filename="${
                encodeURIComponent(filename)
              }"`
            );
            this.pushChunk(this.lineBreak);
            await this.streamFileField(file);
            continue;
          }

          this.pushChunk(
            `Content-Disposition: file; filename="${
              encodeURIComponent(file.filename || `${name}-${filenameIndex++}`)
            }"`
          );
          this.pushChunk(this.lineBreak);
          await this.streamFileField(file.source, file.contentType);
        }

        this.pushChunk(`--${subBoundary}--`);
        this.pushChunk(this.lineBreak);
      } else {
        // buffer or string
        await this.streamFileField(content);
      }
    }

    if(this[kReadNext]) {
      return this.readNext();
    } else {
      return this[kReading] = false;
    }
  }

  async onceResume () {
    if(this[kOnceResume]?.promise) {
      return this[kOnceResume].promise;
    } else {
      this[kOnceResume] = {};
      const promise = new Promise((resolve, reject) => {
        this[kOnceResume].resolve = () => {
          this[kOnceResume] = null;
          return resolve();
        };
        this[kOnceResume].reject = reject;
      });
      this[kOnceResume].promise = promise;
      return promise;
    }
  }

  _destroy(err, cb) {
    if(this[kOnceResume]?.reject) {
      this[kOnceResume].reject(err);
    }
    return cb(err);
  }

  _read(size) {
    if(this[kReading]) {
      if(this[kOnceResume]?.resolve) {
        return this[kOnceResume].resolve();
      } else {
        /**
         * Once the readable._read() method has been called,
         * it will not be called again until more data is pushed
         * through the readable.push()` method. 
         */
        return this[kReadNext] = true;
      }
    } else {
      return this.readNext();
    }
  }

  /**
   * https://github.com/form-data/form-data/blob/master/lib/form_data.js
   * Optimized for boyer-moore parsing
   */
  generateBoundary() {
    return "-".repeat(16).concat(randomBytes(20).toString("base64"));
  }

  pushChunk (chunk) {
    this[kChunkBuffer] = this[kChunkBuffer].concat(chunk);
  }

  flushChunks (encoding) {
    this.push(this[kChunkBuffer], encoding);
    this[kChunkBuffer] = "";
  }

  async streamFileField (file, contentType) {
    assert(file);
  
    if(file.length) { // string or Buffer 
      this.pushChunk(`Content-Type: ${contentType || this.defaultContentType}`);
      this.pushChunk(this.lineBreak.repeat(2));
      this.flushChunks();
      this.push(file);
      return this.push(this.lineBreak);
    }

    if(!(file instanceof Readable))
      throw new Error(`Received non-Readable stream ${file}`);

    this.pushChunk(`Content-Type: ${contentType || this.defaultStreamContentType}`);
    this.pushChunk(this.lineBreak.repeat(2));  
    this.flushChunks();

    for await (const chunk of this.readStream(file)) {
      if(this.push(chunk) === false) {
        await this.onceResume();
      }
    }

    this.push(this.lineBreak);
  }

  async * readStream (stream) {
    let chunk;
    while (stream.readable) {
      await new Promise((resolve, reject)=> {
        stream.once("error", reject)
            .once("end", resolve)
            .once("readable", () => {
              stream.removeListener("end", resolve);
              stream.removeListener("error", reject);
              return resolve();
            });
      });

      if(!stream.readable) break;

      while (null !== (chunk = stream.read())) {
        yield chunk;
      }
    }
  }
}

/**
 * Previously, it was recommended that senders use a Content-Transfer-
   Encoding encoding (such as "quoted-printable") for each non-ASCII
   part of a multipart/form-data body because that would allow use in
   transports that only support a "7bit" encoding.  This use is
   deprecated for use in contexts that support binary data such as HTTP.
   Senders SHOULD NOT generate any parts with a Content-Transfer-
   Encoding header field.
 * https://tools.ietf.org/html/rfc7578
 * @param { FormData } formData an object implemented FormData interface
 * @param {"multipart/form-data" | "application/x-www-form-urlencoded"} type 
 * @returns { body: string | Readable, headers: object }
 */
function serializeFormData(formData, type = formData?.type) {
  const iterator = (
    typeof formData.entries === "function"
    ? formData.entries()
    : formData[Symbol.iterator]
      ? formData[Symbol.iterator]()
      : Object.entries(formData)[Symbol.iterator]()
  );
  
  switch (type) {
    case "multipart/form-data":
      const formDataStream = new FormDataStream(iterator);
      return {
        body: formDataStream,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${formDataStream.boundary}; charset=UTF-8`
        }
      }
    default:
      type && console.warn(`Unknown type ${type} will be treated as application/x-www-form-urlencoded.`)
    case "application/x-www-form-urlencoded":
      const result = [];
      for (const [key, value] of iterator) {
        result.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
      return {
        body: result.join("&"),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        }
      };
  }
}

export { serializeFormData };
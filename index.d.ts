/// <reference types="node" />

import { Readable } from "stream";

type FieldSource = string | Buffer | Readable;

type FieldContentDetails = FieldSource | {
  source: FieldSource;
  filename: string;
  contentType: string;
};

interface FormData {
  [FieldName: string]: FieldContentDetails;
  [MultipleFilesFieldName: string]: Array<FieldContentDetails>;
}

export declare function serializeFormData (
  formData: FormData,
  type?: "multipart/form-data" | "application/x-www-form-urlencoded"
) : { body: string | Readable, headers: { "Content-Type": string } }
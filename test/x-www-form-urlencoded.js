import { serializeFormData } from "../index.js";
import { strictEqual } from "assert";
import querystring from "querystring";

describe("x-www-form-urlencoded", () => {
  it("querystring.stringify", () => {
    const data = {
      a: [1, 4, BigInt(1e26), Infinity, false],
      8: "afbfd",
      [true]: false,
      obj: {
        oh: "gosh"
      }
    };

    const { body, headers } = serializeFormData(data);
    strictEqual(body, querystring.stringify(data));
    strictEqual(headers["Content-Type"], "application/x-www-form-urlencoded; charset=UTF-8");
  });
});
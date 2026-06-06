/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

declare module "ali-oss" {
  interface OSSOptions {
    region?: string;
    accessKeyId: string;
    accessKeySecret: string;
    stsToken?: string;
    bucket?: string;
    endpoint?: string;
    secure?: boolean;
    refreshSTSToken?: () => Promise<{
      accessKeyId: string;
      accessKeySecret: string;
      stsToken: string;
    }>;
    refreshSTSTokenInterval?: number;
  }

  interface PutOptions {
    headers?: Record<string, string>;
  }

  class OSS {
    constructor(options: OSSOptions);
    put(
      name: string,
      file: Buffer | string,
      options?: PutOptions,
    ): Promise<any>;
  }

  export default OSS;
}

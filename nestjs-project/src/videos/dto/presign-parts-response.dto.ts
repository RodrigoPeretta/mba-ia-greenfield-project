import { ApiProperty } from '@nestjs/swagger';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Signed UploadPart URL on the public storage endpoint; the client PUTs the bytes to it',
  })
  url: string;
}

export class PresignPartsResponseDto {
  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({
    description: 'Validity of the URLs in seconds',
    example: 3600,
  })
  expires_in: number;
}

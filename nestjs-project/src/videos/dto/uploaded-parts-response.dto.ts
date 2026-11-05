import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;

  @ApiProperty({
    description: 'Bytes received by the storage for this part',
    example: 67108864,
  })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({
    type: [UploadedPartDto],
    description:
      'Parts already received by the storage, used to resume without re-sending',
  })
  parts: UploadedPartDto[];

  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}

import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

/** The `1..part_count` upper bound depends on the video, so the service checks it (422). */
export class PresignPartsDto {
  /** Part numbers to sign: 1–100 unique integers ≥ 1. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

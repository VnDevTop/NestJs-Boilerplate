import { ApiProperty } from '@nestjs/swagger';

import { Role } from '../../../common/enums/index.js';

/**
 * The grants a role should hold, as a list of permission names.
 *
 * A list rather than a patch: the request is the whole truth about the role after
 * this call. A partial update here would need its own merge rule and its own tests
 * for what a missing name means, and the operator's intent when they open a role
 * editor is normally "these are the ones", not "add one of these".
 */
export class SetRolePermissionsDto {
  @ApiProperty({
    type: [String],
    example: ['user:read', 'user:write'],
    description:
      'The permissions the role holds after this call. An empty list removes every grant.',
  })
  permissions!: string[];
}

/** What a role holds, for the read side. */
export class RolePermissionsDto {
  @ApiProperty({ enum: Role, example: Role.Admin })
  role!: Role;

  @ApiProperty({
    type: [String],
    example: ['admin:health:read', 'user:read'],
    description:
      'The permission names this role holds. Empty for a role with no grants, which is a role that can reach no guarded route.',
  })
  permissions!: string[];

  @ApiProperty({
    example: 2,
    description: 'How many grants were written',
  })
  applied!: number;
}

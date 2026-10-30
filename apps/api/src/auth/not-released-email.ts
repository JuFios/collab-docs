import { Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { isReleasedEmail } from '@collab-docs/shared';

@ValidatorConstraint({ name: 'notReleasedEmail', async: false })
class NotReleasedEmailConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || !isReleasedEmail(value);
  }

  defaultMessage(): string {
    return 'email cannot be used';
  }
}

/**
 * The placeholder an account keeps after it gave up its address must stay free, so nobody registers it, and no
 * mail goes to it, so nobody is invited at it.
 */
export const NotReleasedEmail = (): PropertyDecorator => Validate(NotReleasedEmailConstraint);

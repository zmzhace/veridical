import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplayControls } from '../src/components/ReplayControls';

test('calls onScrub with slider value', () => {
  const onScrub = vi.fn();
  render(<ReplayControls maxSeq={5} value={1} onScrub={onScrub} />);
  const slider = screen.getByRole('slider') as HTMLInputElement;
  fireEvent.change(slider, { target: { value: '3' } });
  expect(onScrub).toHaveBeenCalledWith(3);
});

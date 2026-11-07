import { describe, expect, it } from 'vitest';
import { isInsideZip, ZIP_PROJECT_MESSAGE } from './zip-path';

describe('isInsideZip', () => {
  it("detects Explorer's temp extraction folder and zip tools' temp folders", () => {
    expect(isInsideZip('C:\\Users\\st\\AppData\\Local\\Temp\\Temp1_Lab3.zip\\Lab3\\Lab3.mcp')).toBe(true);
    expect(isInsideZip('C:\\Users\\st\\AppData\\Local\\Temp\\Temp2_blank_project.ZIP\\blank_project.mcp')).toBe(true);
    expect(isInsideZip('C:\\Users\\st\\AppData\\Local\\Temp\\7zO8A1B2C3D\\Lab3.mcp')).toBe(true);
    expect(isInsideZip('C:\\Users\\st\\AppData\\Local\\Temp\\Rar$DIa1234.5678\\Lab3.mcp')).toBe(true);
  });

  it('accepts extracted folders and ordinary paths', () => {
    expect(isInsideZip('C:\\Users\\st\\Downloads\\Lab3\\Lab3.mcp')).toBe(false);
    expect(isInsideZip('C:\\Users\\st\\Downloads\\Lab3.zip_extracted\\Lab3.mcp')).toBe(false);
    expect(isInsideZip('/home/st/zips/Lab3/Lab3.mcp')).toBe(false);
    // a real folder named like an archive (e.g. made by an unzip tool) opens normally
    expect(isInsideZip('/Users/st/Downloads/Lab3.zip/Lab3/Lab3.mcp')).toBe(false);
    expect(isInsideZip('C:\\Users\\st\\Temp1_Lab3\\Lab3.mcp')).toBe(false);
    // only folders count: a file named like an archive is not "inside" one
    expect(isInsideZip('/home/st/Lab3.zip')).toBe(false);
    expect(isInsideZip('Lab3.mcp')).toBe(false);
  });

  it('message tells the student what to do', () => {
    expect(ZIP_PROJECT_MESSAGE).toMatch(/Extract All/);
  });
});

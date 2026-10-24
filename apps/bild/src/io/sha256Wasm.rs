#![no_std]

use core::panic::PanicInfo;

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

static mut INPUT: [u8; 1_048_576] = [0; 1_048_576];
static mut STATE: [u32; 8] = [0; 8];
static mut PENDING: [u8; 64] = [0; 64];
static mut PENDING_LEN: usize = 0;
static mut TOTAL_LEN: u64 = 0;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! { loop {} }

#[no_mangle]
pub extern "C" fn sha_buffer() -> *mut u8 { core::ptr::addr_of_mut!(INPUT) as *mut u8 }

#[no_mangle]
pub extern "C" fn sha_init() {
    unsafe {
        STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        PENDING_LEN = 0; TOTAL_LEN = 0;
    }
}

unsafe fn compress(data: *const u8) {
    let mut w = [0u32; 64];
    for i in 0..16 {
        let p = data.add(i * 4);
        w[i] = ((*p as u32) << 24) | ((*p.add(1) as u32) << 16) | ((*p.add(2) as u32) << 8) | *p.add(3) as u32;
    }
    for i in 16..64 {
        let x = w[i - 15]; let y = w[i - 2];
        let s0 = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
        let s1 = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
        w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }
    let state = core::ptr::addr_of_mut!(STATE) as *mut u32;
    let mut a = *state; let mut b = *state.add(1); let mut c = *state.add(2); let mut d = *state.add(3);
    let mut e = *state.add(4); let mut f = *state.add(5); let mut g = *state.add(6); let mut h = *state.add(7);
    for i in 0..64 {
        let t1 = h.wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
            .wrapping_add((e & f) ^ (!e & g)).wrapping_add(K[i]).wrapping_add(w[i]);
        let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
            .wrapping_add((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b; b = a; a = t1.wrapping_add(t2);
    }
    *state = (*state).wrapping_add(a); *state.add(1) = (*state.add(1)).wrapping_add(b);
    *state.add(2) = (*state.add(2)).wrapping_add(c); *state.add(3) = (*state.add(3)).wrapping_add(d);
    *state.add(4) = (*state.add(4)).wrapping_add(e); *state.add(5) = (*state.add(5)).wrapping_add(f);
    *state.add(6) = (*state.add(6)).wrapping_add(g); *state.add(7) = (*state.add(7)).wrapping_add(h);
}

#[no_mangle]
pub extern "C" fn sha_update(length: usize) {
    unsafe {
        TOTAL_LEN = TOTAL_LEN.wrapping_add(length as u64);
        let mut offset = 0usize;
        if PENDING_LEN != 0 {
            let take = core::cmp::min(64 - PENDING_LEN, length);
            core::ptr::copy_nonoverlapping((core::ptr::addr_of!(INPUT) as *const u8).add(offset),
                (core::ptr::addr_of_mut!(PENDING) as *mut u8).add(PENDING_LEN), take);
            PENDING_LEN += take; offset += take;
            if PENDING_LEN == 64 { compress(core::ptr::addr_of!(PENDING) as *const u8); PENDING_LEN = 0; }
        }
        while offset + 64 <= length {
            compress((core::ptr::addr_of!(INPUT) as *const u8).add(offset)); offset += 64;
        }
        if offset < length {
            PENDING_LEN = length - offset;
            core::ptr::copy_nonoverlapping((core::ptr::addr_of!(INPUT) as *const u8).add(offset),
                core::ptr::addr_of_mut!(PENDING) as *mut u8, PENDING_LEN);
        }
    }
}

#[no_mangle]
pub extern "C" fn sha_finish() -> *const u8 {
    unsafe {
        let pending = core::ptr::addr_of_mut!(PENDING) as *mut u8;
        core::ptr::write_bytes(pending.add(PENDING_LEN), 0, 64 - PENDING_LEN);
        *pending.add(PENDING_LEN) = 0x80;
        if PENDING_LEN >= 56 { compress(pending); core::ptr::write_bytes(pending, 0, 64); }
        let bits = TOTAL_LEN.wrapping_mul(8).to_be_bytes();
        core::ptr::copy_nonoverlapping(bits.as_ptr(), pending.add(56), 8); compress(pending);
        let state = core::ptr::addr_of!(STATE) as *const u32;
        let output = core::ptr::addr_of_mut!(INPUT) as *mut u8;
        for i in 0..8 { core::ptr::copy_nonoverlapping((*state.add(i)).to_be_bytes().as_ptr(), output.add(i * 4), 4); }
        output
    }
}

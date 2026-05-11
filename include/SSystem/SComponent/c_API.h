#ifndef C_API_H
#define C_API_H

typedef void (*cAPIGph_Mthd)(void);
// The Create/BeforeOfDraw/AfterOfDraw/Painter slots in cAPI_Interface get
// initialized to functions that return int (mDoGph_Painter et al.). Native
// compilers tolerated the (cAPIGph_Mthd) cast that discarded the return type;
// wasm CFI traps the indirect call. Use the int-returning variant for those
// slots; keep the void-returning typedef for blankingOn/Off which really are
// void.
typedef int (*cAPIGph_IntMthd)(void);

struct cAPI_Interface {
    /* 0x00 */ cAPIGph_IntMthd createMtd;
    /* 0x04 */ cAPIGph_IntMthd beforeOfDrawMtd;
    /* 0x08 */ cAPIGph_IntMthd afterOfDrawMtd;
    /* 0x0C */ cAPIGph_IntMthd painterMtd;
    /* 0x10 */ cAPIGph_Mthd blankingOnMtd;
    /* 0x14 */ cAPIGph_Mthd blankingOffMtd;
};

extern cAPI_Interface g_cAPI_Interface;

#endif /* C_API_H */

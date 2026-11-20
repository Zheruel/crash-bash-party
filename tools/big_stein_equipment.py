"""Big Stein's equipment trim, using the portrait's navy, red and brass."""

import numpy as np

from custom_character_assets import Shape, replace_kart, tint_barrel_bands, tint_equipment

NAVY = '303961'
MIDNIGHT = '252842'
SILVER = 'a8a8b6'
BRASS = 'c49b5e'
RED = 'bf2535'


def stein_kart():
    kart = Shape()

    def hull(rows, paint):
        sections = [
            [(-w*.81,bottom,z),(w*.81,bottom,z),(w,bottom+23,z),
             (w*.84,y,z),(-w*.84,y,z),(-w,bottom+23,z)]
            for z,w,bottom,y in rows
        ]
        kart.loft([MIDNIGHT, paint, NAVY, paint, NAVY, paint], sections)

    hull([(-255,139,-35,26),(-204,188,-51,66),(-96,209,-53,87),
          (34,191,-47,60),(155,181,-37,64),(213,147,-24,49)], NAVY)
    hull([(39,115,54,89),(97,152,50,103),(154,159,48,100),(212,132,41,73)], '404a78')
    hull([(-222,141,55,102),(-183,165,56,135),(-127,133,52,125),(-102,111,53,96)], MIDNIGHT)
    kart.polygon(MIDNIGHT, (-90,69,43),(90,69,43),(108,82,-98),(-108,82,-98))

    def nose(x, z, raised=0):
        slope = 27/58 if z > 154 else 3/57
        return x, 100-slope*(z-154)+raised, z

    # Hood crest echoes the red diamond on his jacket.
    kart.polygon(SILVER, nose(0,181,5),nose(44,155,5),nose(0,128,5),nose(-44,155,5))
    kart.polygon(RED, nose(0,177,6),nose(36,155,6),nose(0,132,6),nose(-36,155,6))
    kart.polygon(MIDNIGHT, nose(0,168,7),nose(21,155,7),nose(0,141,7),nose(-21,155,7))
    for side in (-1,1):
        def panel(color, points):
            corners = [(side*x,y,z) for x,y,z in points]
            kart.polygon(color, *corners if side > 0 else corners[::-1])

        panel(SILVER, [(49,62,214),(138,61,209),(151,79,190),(61,85,193)])
        panel('f0d89d', [(63,66,212),(126,65,210),(133,73,203),(67,77,203)])
        panel(RED, [(179,59,88),(194,47,59),(210,37,-87),(197,53,-149),
                    (205,65,-145),(211,49,-87),(195,55,59),(182,64,88)])
        # Exposed twin thrusters, with brass lips against the navy shell.
        def exhaust(z, radius):
            return [(side*99+radius*x, 39+radius*y, z) for x,y in
                    [(-.70,-.7),(.70,-.7),(1,0),(.70,.7),(-.70,.7),(-1,0)]]
        kart.loft([NAVY]*6,[exhaust(-211,42),exhaust(-250,37)])
        kart.polygon(BRASS, *exhaust(-251,32))
        kart.polygon(MIDNIGHT, *exhaust(-252,24))
        kart.polygon(RED, *exhaust(-253,14))
        panel(BRASS, [(56,86,44),(77,81,39),(76,112,54),(61,118,56)])
    return kart


def paint_variants():
    replace_kart(9005, stein_kart(), 'Stein navy and brass')
    navy = (-.28,-.27,.36)
    brass = (.25,.03,-.34)
    trim = {2: brass, 3: navy, 5: navy}
    for number in (9002, 9003, 9008, 9013):
        tint_equipment(number, trim)
    tint_equipment(9006, {6: (-.26,-.14,.46)}, lambda p: np.clip((p[:,1]+100)/230,0,1))
    tint_equipment(9007, {2: (-.12,-.11,.31)},
                   lambda p: np.clip((p[:,1]-175)/200,0,1) * np.clip((65-p[:,2])/143,0,1))
    tint_equipment(9009, {0: navy, 7: (-.04,-.17,-.15), 8: brass})
    tint_barrel_bands(9010, 'Brass-banded barrel', (.22,.08,-.26))
    tint_equipment(9011, {1: navy, 5: brass})
